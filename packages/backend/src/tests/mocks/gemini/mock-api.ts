import { AI_FEATURE } from '@bt/shared/types';
import { FALLBACK_SERVER_MODELS } from '@services/ai/resolution-ladder';
import { HttpResponse, delay, http } from 'msw';

// Gemini API uses a different URL pattern, with the model name baked into the
// path. Wildcard the model segment so swapping the configured default model
// doesn't silently unmatch every handler here.
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/*';

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const VALID_GEMINI_API_KEY = 'test-valid-gemini-key-12345';
export const INVALID_GEMINI_API_KEY = 'test-invalid-gemini-key';

/** Chat models the default list handler reports; it also lists an embedding model the app must skip. */
export const GEMINI_LISTED_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemma-4-31b-it'];

function readApiKey({ request }: { request: Request }): string | null {
  // The SDK sends the key as the `x-goog-api-key` header; the REST API also
  // accepts a `?key=` query param, so honour both transports.
  return request.headers.get('x-goog-api-key') ?? new URL(request.url).searchParams.get('key');
}

/** Gemini answers a bad key with a 400, not a 401. */
function invalidKeyResponse() {
  return HttpResponse.json(
    {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
        ],
      },
    },
    { status: 400 },
  );
}

/** Most callers of this mock exercise categorization; others pass `expectedModel`. */
const DEFAULT_EXPECTED_MODEL = FALLBACK_SERVER_MODELS[AI_FEATURE.categorization]!.model;

/**
 * Pulls the `<model>` segment out of `.../v1beta/models/<model>:generateContent`.
 * Returns null if the URL doesn't match that shape at all.
 */
function extractModelSegment({ url }: { url: string }): string | null {
  const match = /\/v1beta\/models\/([^/:]+):/.exec(url);
  return match?.[1] ?? null;
}

/**
 * The wildcarded URL matches any model, so this is the only place that still
 * checks the app requested the model it was configured for. Returns an error
 * response (instead of throwing) so the failure surfaces as a readable test
 * assertion rather than an unhandled rejection inside the MSW handler. Exported
 * so other Gemini handlers (e.g. the investment-import CSV mock) can reuse the
 * same check instead of re-implementing it.
 */
export function rejectIfWrongModel({ request, expectedModel }: { request: Request; expectedModel: string }) {
  const actualModel = extractModelSegment({ url: request.url });
  if (actualModel === expectedModel) return null;

  return HttpResponse.json(
    {
      error: {
        code: 400,
        message: `Mock Gemini handler expected model "${expectedModel}" but request targeted "${actualModel}". Request URL: ${request.url}`,
        status: 'INVALID_ARGUMENT',
      },
    },
    { status: 400 },
  );
}

/** Category name to the ordinal the prompt gave it, read from the CATEGORIES table ("c3|parent|Name"). */
async function readPromptCategoryOrdinals({ request }: { request: Request }): Promise<Map<string, number>> {
  const ordinals = new Map<string, number>();
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as {
    contents?: { parts?: { text?: string }[] }[];
  } | null;
  const prompt = (body?.contents ?? [])
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n');

  for (const match of prompt.matchAll(/^c(\d+)\|[^|]*\|(.*)$/gm)) {
    ordinals.set(match[2]!, Number(match[1]));
  }

  return ordinals;
}

interface MockCategorizationOptions {
  /** Map of transaction ordinal to category ordinal (1-based, prompt order), emitted as "t1:c2" alias pairs */
  categorizations?: Record<number, number>;
  /**
   * Map of transaction ordinal to a category name, resolved against the CATEGORIES table of the
   * prompt, so a test need not know the order the app lists categories in
   */
  categorizationsByName?: Record<number, string>;
  /** Map of transaction ordinal to a skip reason code, emitted as "t1:skip:transfer" lines */
  skips?: Record<number, string>;
  /** Verbatim response text; overrides categorizations/skips (e.g. a prose refusal) */
  rawText?: string;
  /** finishReason for the candidate; MAX_TOKENS simulates a truncated response */
  finishReason?: string;
  /** If true, returns an error response */
  shouldFail?: boolean;
  /** Custom error status code */
  errorStatus?: number;
  /** Model the request must target; defaults to the categorization feature's model */
  expectedModel?: string;
  /**
   * Let requests for other models fall through to the next handler instead of answering a 400.
   * Always register a handler for that other model after this one: msw runs with
   * `onUnhandledRequest: 'bypass'`, so an unmatched request goes to the real Gemini API.
   */
  passthroughOtherModels?: boolean;
  /** Hold the response for this long, simulating a slow model */
  delayMs?: number;
}

/**
 * Creates a mock response for the Gemini generateContent API
 * Returns categorization in the short-alias format "t<n>:c<n>" per line
 */
export function createGeminiMock(options: MockCategorizationOptions = {}) {
  const {
    categorizations = {},
    categorizationsByName = {},
    skips = {},
    rawText,
    finishReason = 'STOP',
    shouldFail = false,
    errorStatus = 500,
    expectedModel = DEFAULT_EXPECTED_MODEL,
    passthroughOtherModels = false,
    delayMs = 0,
  } = options;

  return http.post(GEMINI_API_URL, async ({ request }) => {
    const modelMismatch = rejectIfWrongModel({ request, expectedModel });
    if (modelMismatch) return passthroughOtherModels ? undefined : modelMismatch;

    if (delayMs) await delay(delayMs);

    const promptCategoryOrdinals = await readPromptCategoryOrdinals({ request });

    if (readApiKey({ request }) === INVALID_GEMINI_API_KEY) {
      return invalidKeyResponse();
    }

    // Simulate failure if requested
    if (shouldFail) {
      return HttpResponse.json(
        {
          error: {
            code: errorStatus,
            message: 'Internal server error',
            status: 'INTERNAL',
          },
        },
        { status: errorStatus },
      );
    }

    const unknownCategory = Object.values(categorizationsByName).find((name) => !promptCategoryOrdinals.has(name));
    if (unknownCategory !== undefined) {
      return HttpResponse.json(
        {
          error: {
            code: 400,
            message: `Category "${unknownCategory}" is not in the prompt`,
            status: 'INVALID_ARGUMENT',
          },
        },
        { status: 400 },
      );
    }

    const responseText =
      rawText ??
      [
        ...Object.entries(categorizationsByName).map(
          ([txOrdinal, name]) => `t${txOrdinal}:c${promptCategoryOrdinals.get(name)}`,
        ),
        ...Object.entries(categorizations).map(([txOrdinal, catOrdinal]) => `t${txOrdinal}:c${catOrdinal}`),
        ...Object.entries(skips).map(([txOrdinal, reason]) => `t${txOrdinal}:skip:${reason}`),
      ].join('\n');

    return HttpResponse.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: responseText || '# No categorizations',
              },
            ],
            role: 'model',
          },
          finishReason,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    });
  });
}

const modelListHandler = http.get(GEMINI_MODELS_URL, ({ request }) => {
  if (readApiKey({ request }) === INVALID_GEMINI_API_KEY) {
    return invalidKeyResponse();
  }

  return HttpResponse.json({
    models: [
      ...GEMINI_LISTED_MODELS.map((id) => ({
        name: `models/${id}`,
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      })),
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  });
});

/** Default handlers. `generateContent` stays opt-in through `createGeminiMock`, which pins the model. */
export const geminiHandlers = [modelListHandler];
