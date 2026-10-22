# Payment Shortcuts

The iOS Automation page (Accounts → iOS Automation) offers two signed Shortcuts as **Add Shortcut**. The page hides a button while its file is missing (a HEAD probe), so a file can be added later. nginx serves this directory at `/shortcuts/` as a download.

| Button            | File                        | What it does                                                                                                                       |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| iOS 27 or later   | `log-payments.shortcut`     | Carries its own triggers (Wallet Transaction and Notification), logs taps and bank notifications, gates notifications on the phone |
| iOS 26 or earlier | `log-card-payment.shortcut` | Logs the payment of a Wallet Transaction automation the user creates by hand                                                       |

## Where they come from

The Shortcuts are generated, not drawn:

- `scripts/shortcuts/shortcut-plist.ts` holds the action names, the token serialization and the steps both Shortcuts share.
- `scripts/shortcuts/build-payments-shortcut.ts` builds the iOS 27 one, `build-card-payment-shortcut.ts` the iOS 26 one.
- `npm run shortcuts:build` (in `packages/frontend`) writes `shortcuts/log-payments.plist` and `shortcuts/log-card-payment.plist`. They are committed so a change is reviewable as a diff.
- The specs (`build-payments-shortcut.spec.ts`, `build-card-payment-shortcut.spec.ts`) fail when a committed XML differs from the generator output.
- `scripts/shortcuts/fixtures/transaction-input.xml` is a Shortcut captured on a device from a Wallet **Transaction** automation: the input's property names (`Merchant`, `Amount`, `Card or Pass`, `Name`) come from it.
- `scripts/shortcuts/fixtures/triggers-input.xml` is one exported from an iOS 27 iPhone with both triggers: the `WFWorkflowTriggers` shape and the `SelectedApps` entries come from it.

The action identifiers and parameter keys are the one thing the generators take on trust: they are listed in `SHORTCUT_ACTIONS` and `SHORTCUT_PARAMS` in `shortcut-plist.ts`. The Match Text, Wait and If condition keys are not in a device export yet. If the phone refuses the import or shows an action with empty fields, fix them there, rebuild and sign again.

## What the iOS 27 Shortcut does

1. Decodes the setup code (url, token, Cloudflare Access pair, optional `gate`), points the url at `/ingest/event`, and takes the setup code's gate regex or the built-in standard one.
2. A Wallet tap (`Transaction → Merchant` has a value) posts `kind: walletTransaction` with the run time and `timeSource: run`.
3. A notification (`Notification → App` has a value) stops when it comes from the Shortcuts app or the MoneyMatter web app, then runs **Match Text** on title, subtitle and body with the gate. Without a match it stops a text that asks for a one-time code (`SECURITY_GATE_PATTERN`, the server's markers), then matches the app's name against the messaging and mail apps (`CONVERSATIONAL_APP_GATE_PATTERN`): those post a `notificationProbe` with the app and the sender only and go on only when the answer says `send: yes` (the sender is a context source); any other app of the trigger list is posted, and the server decides by the source's mode (a context source is read, anything else without an amount is dropped before it is stored). Posted as `kind: notification` with the notification's own date.
4. A manual run posts a dry run.
5. On a 423 (a base-currency change is running) it waits 20 seconds and sends the same body and key once more.
6. It shows the answer's `summary`, or its `message` on an error, and nothing for an ignored or dropped notification. The banner has no title of its own: iOS names the shortcut once in its header.

After any change to a generator, the signed `.shortcut` must be exported again from an iPhone (import the regenerated plist, export, replace the file here); until then `served-payments-shortcut.spec.ts` reports that the served file differs from the generated one.

The trigger variables render the run's input whatever trigger fired, so the Shortcut tells the two apart by typed properties only. It never reads `Sender` or `Recipients`: a notification that is not a chat has neither, and the missing property silently aborts the step.

The Notification trigger ships with **Wallet** and **Messages** selected. iOS has no "any app", and a trigger with an empty list stays off, so the user adds the bank and mail apps on the phone (the setup text says so). Imported triggers arrive switched off; the user turns **Automation** on for each.

## Signing

iOS imports only signed Shortcuts.

### iOS 26 or earlier (macOS)

On a Mac signed in to an Apple ID:

```sh
cd packages/frontend
npm run shortcuts:build
plutil -convert binary1 -o /tmp/log-card-payment-unsigned.shortcut shortcuts/log-card-payment.plist
shortcuts sign --mode anyone \
  --input /tmp/log-card-payment-unsigned.shortcut \
  --output public/shortcuts/log-card-payment.shortcut
```

`shortcuts sign` reads only a binary plist whose name ends in `.shortcut`; given the XML `.plist` or a `.bin` it fails with "The file couldn’t be opened because it isn’t in the correct format". Check what the signature exposes about the signing identity before committing the file to a public repository.

### iOS 27 or later (an iPhone)

The iOS 27 Shortcut ships as this file, served from our own server; the page's iOS 27 button downloads `/shortcuts/log-payments.shortcut`.

macOS 26 `shortcuts sign` rewrites the client version and drops `WFWorkflowTriggers`, and iOS refuses an unsigned file. The triggers survive an export from an iOS 27 iPhone, so the regeneration loop is:

1. Generate: `npm run shortcuts:build` writes `shortcuts/log-payments.plist`.
2. Sign on the Mac only to get a file the iPhone will import: convert to a binary `.shortcut` as above, then `shortcuts sign --mode anyone --input /tmp/log-payments-unsigned.shortcut --output /tmp/log-payments.shortcut`. The result has no triggers.
3. AirDrop it to the iOS 27 iPhone and import it with the setup code left empty. Add or verify both triggers: a **Transaction** trigger (no card filter) and a **Notification** trigger with **Wallet** and **Messages** selected. Export the Shortcut as a file (Share → Save to Files). The phone signs the export and keeps the triggers.
4. Save that file as `public/shortcuts/log-payments.shortcut` and check what its signature exposes about the signing identity before committing it to a public repository.

`scripts/shortcuts/served-payments-shortcut.spec.ts` decodes the served file (macOS only: `aea`, `aa`, `plutil`, `openssl`) and compares its actions and triggers with the generated plist, not its bytes, so the iPhone's re-signature does not trip it. It skips when the file is missing or the tools are. Regenerate the file whenever the generator changes the actions.

Until the file exists the page hides the iOS 27 button (the HEAD probe fails), exactly as for the iOS 26 file.

## Verifying

1. Import the signed file on an iPhone. The import asks for one thing, the setup code.
2. Paste a setup code from the instance (Accounts → iOS Automation → **Generate setup code**).
3. Run the Shortcut by hand. With no input it sends a dry run and shows `Connected as <username>. …`.
4. iOS 27: turn **Automation** on for both triggers, add the bank app to the Notification trigger, then tap a linked card and check that the banner reads `Logged …`. A bank push in the selected app logs the same way.
5. iOS 26: create the Transaction automation, tap a linked card and check the same banner.

## Debugging on a device

iOS keeps no run history for Shortcuts automations, and the served Shortcut carries no debug actions. To see why a run did not fire or which action failed, read the iPhone's system log from a Mac:

- Live: connect the iPhone by cable (trusted), open Console.app, select the phone and filter on `shortcuts` or `WorkflowKit`.
- After the fact: `sudo log collect --device-name "<iPhone name>" --last 2h --output iphone.logarchive`, then open the archive in Console.app or search it with `log show --archive iphone.logarchive --predicate 'process CONTAINS "shortcuts"'`.

iOS keeps only a limited window of logs (hours to a day or two, depending on how busy the phone is), so collect them soon after the run in question. To trace a run on the iPhone itself, add actions to a personal copy of the Shortcut, never to the served file.
