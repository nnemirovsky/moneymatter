# Card-payment Shortcut

`moneymatter-log-card-payment.shortcut` is the signed Shortcut that Settings → Integrations → Apple Pay offers as **Add Shortcut**. The page hides the button while the file is missing (a HEAD probe), so the file can be added later. nginx serves this directory at `/shortcuts/` as a download.

## Where it comes from

The Shortcut is generated, not drawn:

- `scripts/shortcuts/build-card-payment-shortcut.ts` builds the XML property list.
- `npm run shortcuts:build` (in `packages/frontend`) writes it to `shortcuts/log-card-payment.plist`, which is committed so a change is reviewable as a diff.
- The spec `scripts/shortcuts/build-card-payment-shortcut.spec.ts` fails when the committed XML differs from the generator output.
- `scripts/shortcuts/fixtures/transaction-input.xml` is a Shortcut captured on a device from a Wallet **Transaction** automation. It is where the input's property names (`Merchant`, `Amount`, `Card or Pass`, `Name`) come from.

The action identifiers and parameter keys are the one thing the generator takes on trust: they are listed in `SHORTCUT_ACTIONS` and `SHORTCUT_PARAMS` at the top of the script. If the phone refuses the import or shows an action with empty fields, fix them there, rebuild and sign again.

## Signing (macOS, once per release of the Shortcut)

iOS imports only signed Shortcuts. On a Mac signed in to an Apple ID:

```sh
cd packages/frontend
npm run shortcuts:build
shortcuts sign --mode anyone \
  --input shortcuts/log-card-payment.plist \
  --output public/shortcuts/moneymatter-log-card-payment.shortcut
```

If the CLI refuses the XML, convert it first: `plutil -convert binary1 -o /tmp/log-card-payment.bin shortcuts/log-card-payment.plist` and sign that. Check what the signature exposes about the signing identity before committing the file to a public repository.

## Verifying

1. AirDrop the signed file to an iPhone and import it. The import asks for one thing, the setup code.
2. Paste a setup code from the instance (Settings → Integrations → Apple Pay → **Generate setup code**).
3. Run the Shortcut by hand. With no input it sends a dry run and shows `Connected as <username>. …`.
4. Create the Transaction automation, tap a linked card and check that the notification reads `Logged …`.

An iCloud share link of the imported Shortcut is an alternative to the file: set `CARD_PAYMENT_SHORTCUT_ICLOUD_URL` on the frontend container (read at start, no rebuild). It asks for the setup code the same way.
