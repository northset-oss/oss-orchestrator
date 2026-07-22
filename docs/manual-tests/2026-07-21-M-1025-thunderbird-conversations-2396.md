# Human manual test for M-1025 / Thunderbird Conversations PR #2396

This is the operator guide for the manual test requested by the maintainer on
[`thunderbird-conversations/thunderbird-conversations#2396`](https://github.com/thunderbird-conversations/thunderbird-conversations/pull/2396).
The associated issue is
[`#2049`](https://github.com/thunderbird-conversations/thunderbird-conversations/issues/2049),
“Consider showing the full subject on the vertical layout / Separate tabs.”

## Human-ownership requirement

The maintainer explicitly requires **Aysajan to perform this test personally**. Before testing or
responding, personally read the latest upstream
[`AGENTS.md`](https://github.com/thunderbird-conversations/thunderbird-conversations/blob/main/AGENTS.md)
and
[`CONTRIBUTING.md`](https://github.com/thunderbird-conversations/thunderbird-conversations/blob/main/CONTRIBUTING.md).

Those files require the contributor to understand and take responsibility for every changed line,
perform the Thunderbird test, and write any PR response personally without AI-assisted wording.
This guide can organize the test, but it cannot perform the human observation or write the response.

Do not reuse the existing images under `runs/factory/manual/M-1025-ui-evidence/`. They are retained
as audit artifacts, but the maintainer has rejected the agent-performed test as a substitute for
human testing. Take every screenshot below yourself during a new run.

## Exact target

| Item | Required value |
| --- | --- |
| PR | `thunderbird-conversations/thunderbird-conversations#2396` |
| Issue | `thunderbird-conversations/thunderbird-conversations#2049` |
| Commit to test | `c9d76b2df2b280636a55422d522fde38f31edcc1` |
| Thunderbird | `152.0.1` |
| Add-on version | `4.3.10` |
| Profile | New, dedicated test profile with synthetic mail only |

Stop and refresh this guide if the PR head no longer equals the commit above.

## What the change is supposed to do

The subject being tested is the **conversation header above the displayed messages**. Do not judge
the subject text in Thunderbird's message-list row; that is not the component changed by this PR.

Expected behavior:

1. Classic three-pane layout: the conversation header stays on one line and truncates with an
   ellipsis when it is too long.
2. Vertical layout: the complete subject wraps over multiple lines.
3. Switching Classic → Vertical → Classic → Vertical while the same conversation remains open
   immediately changes between truncation and wrapping. Do not reload or reselect the conversation.
4. A conversation opened in a separate tab shows the complete wrapped subject.
5. A conversation opened in a standalone message window shows the complete wrapped subject.

The standalone-window case is included because the code and current PR body claim it works. If you
do not personally test it, that claim must not remain in the PR body.

## First understand the six changed files

Open the PR's **Files changed** tab and personally read all six files before running the test:

- `addon/content/components/conversation/conversationHeader.mjs`
- `addon/content/conversation.css`
- `addon/content/reducer/controllerActions.mjs`
- `addon/content/reducer/reducerSummary.mjs`
- `addon/tests/conversationHeader.test.mjs`
- `addon/tests/reducerController.test.mjs`

Confirm you understand these points from the diff:

- the `wrap` attribute is enabled only for vertical, separate-tab, and standalone views;
- the CSS changes the subject from one-line ellipsis to normal multi-line wrapping;
- the current mail-tab layout is read when the conversation loads;
- a resize event re-reads the layout so an already-open conversation updates after a layout switch;
- the Redux summary state stores the current layout;
- the tests cover view-specific wrapping and the cached-layout update.

Do not continue if you cannot explain the purpose of a changed block in your own words.

## Required screenshots

Use macOS `Shift-Command-4` and capture the Thunderbird window or the smallest useful region. Keep
the synthetic subject and enough surrounding UI visible to prove which view is active. Do not crop
away the conversation header.

| File | Take it when | Must show |
| --- | --- | --- |
| `00-thunderbird-version.png` | Before loading the add-on | **About Thunderbird** showing `152.0.1` |
| `01-temporary-addon.png` | After loading the build | Debug Add-ons page showing Conversations `4.3.10` loaded temporarily |
| `02-classic-before-switch.png` | First Classic test | Classic three-pane layout; conversation header is one truncated line |
| `03-vertical-after-live-switch.png` | Immediately after Classic → Vertical | Same open conversation; full header wraps over multiple lines |
| `04-classic-after-live-switch-back.png` | Immediately after Vertical → Classic | Same open conversation; header returns to one truncated line |
| `05-vertical-after-second-live-switch.png` | Immediately after Classic → Vertical again | Same open conversation; full header wraps again |
| `06-separate-tab.png` | After opening the conversation in its own tab | Separate tab and complete wrapped conversation header |
| `07-standalone-window.png` | After opening a message in a new window | Standalone window and complete wrapped conversation header |

Turn on Do Not Disturb first. The dedicated profile and supplied fixtures contain no real account
data. Still inspect every image before sharing it.

Save the new files in a distinct human-evidence folder so they cannot be confused with the rejected
agent-run images:

```sh
mkdir -p /Users/aeziz-local/oss-orchestrator/runs/factory/manual/M-1025-human-ui-evidence
```

macOS initially gives screenshots generic names. Immediately after each capture, rename and move it
to that directory using the exact file name in the table. `Shift-Command-4`, then Space, captures a
whole window when that is clearer than a selected region.

## Step 1: verify and build the exact PR head

Open Terminal and run:

```sh
cd /Users/aeziz-local/oss-orchestrator/runs/factory/artifacts/M-1025/refresh-A1BD9p/repo
git status --short
git rev-parse HEAD
npm ci
npm test
npm run build
```

Required observations:

- `git status --short` prints nothing;
- `git rev-parse HEAD` prints `c9d76b2df2b280636a55422d522fde38f31edcc1`;
- `npm ci`, `npm test`, and `npm run build` all exit successfully;
- `dist/manifest.json` exists after the build.

The current dependency install reports six audit findings; do not run `npm audit fix` or alter
dependencies during this test. The successful build also prints existing `cp` warnings for raw
component files before completing the webpack/XPI build with exit code `0`. Preserve that output and
judge the command by its final exit status; these known messages are not a reason to change the PR.

Record the pass/fail result of each command in the results table near the end. A screenshot of the
terminal is optional; command output is not a substitute for the UI test.

## Step 2: start Thunderbird with a new human-test profile

The Thunderbird `152.0.1` application currently available on this Mac is:

```text
/private/tmp/northset-thunderbird-capture/mount/Thunderbird.app
```

Launch its profile manager from Terminal:

```sh
"/private/tmp/northset-thunderbird-capture/mount/Thunderbird.app/Contents/MacOS/thunderbird" \
  -ProfileManager -no-remote
```

In the profile manager:

1. Click **Create Profile**.
2. Name it `M1025-human-manual-test`.
3. Finish creation, select that profile, and start Thunderbird.
4. Do not connect a real email account. Skip or close account setup so only **Local Folders** is
   used.
5. Set the Thunderbird window to roughly 900–1100 pixels wide and keep the same window size for the
   layout tests. The supplied subject is long enough to wrap at this width.

Open **Thunderbird → About Thunderbird** on macOS and confirm `152.0.1`.

Take screenshot **`00-thunderbird-version.png`** now.

If the application path is missing, stop. Do not silently use another Thunderbird version.

## Step 3: load the exact temporary add-on build

In Thunderbird:

1. Open the three-bar menu.
2. Select **Tools → Developer Tools → Debug Add-ons**.
3. Click **Load Temporary Add-on**.
4. Navigate to:

   ```text
   /Users/aeziz-local/oss-orchestrator/runs/factory/artifacts/M-1025/refresh-A1BD9p/repo/dist
   ```

5. Select `manifest.json`.
6. Confirm the page lists the Conversations add-on at version `4.3.10` without a load error.

Take screenshot **`01-temporary-addon.png`** now.

## Step 4: import the safe two-message fixture

The two committed fixture messages use only reserved `example.invalid` addresses:

```text
/Users/aeziz-local/oss-orchestrator/docs/manual-tests/fixtures/M-1025/long-subject.eml
/Users/aeziz-local/oss-orchestrator/docs/manual-tests/fixtures/M-1025/long-subject-reply.eml
```

Personally open both files in a text editor first. Confirm that the subject is identical except for
the reply's `Re:` prefix, and that `In-Reply-To` and `References` link the reply to the first message.

Then, in Thunderbird:

1. Under **Local Folders**, create a folder named `M1025 Manual Test`.
2. Open that folder so its empty message list is visible.
3. In Finder, select both `.eml` files and drag them into that message list.
4. Set the folder/message list to **Threaded** view.
5. Confirm the reply is nested beneath the first message in one thread.
6. Select the conversation and confirm the Conversations add-on renders both messages together.

Freshly imported local messages may need a brief moment to be indexed. If the message list shows the
correct thread but the conversation pane initially shows only one message, wait briefly and reselect
the thread once. Record that initial delay. Do not confuse an indexing delay with the later live
layout-switch test, where reload or reselection is not allowed.

If drag-and-drop does not import the messages, stop and record exactly what happened. Do not switch
to personal mail just to continue.

## Step 5: test the Classic baseline

1. With the synthetic conversation selected, choose **View → Layout → Classic View**. The same
   choices may appear under the three-bar menu's **View → Layout** submenu.
2. Keep the Thunderbird window at the width chosen in Step 2.
3. Look at the conversation header immediately above the message cards.
4. Confirm it occupies exactly one line and is truncated with an ellipsis.
5. Confirm the rest of the conversation still renders normally.

Take screenshot **`02-classic-before-switch.png`** now.

Result is FAIL if the header expands to multiple lines in Classic view.

## Step 6: test the live layout transition

The same conversation must remain selected and open throughout this entire step. Do not reload the
add-on, change folders, click another message, close the conversation, or restart Thunderbird.

1. Switch **Classic View → Vertical View**.
2. Wait no longer than a normal UI refresh.
3. Confirm the complete subject immediately wraps over multiple lines.
4. Take screenshot **`03-vertical-after-live-switch.png`**.
5. Switch **Vertical View → Classic View** without reselecting the message.
6. Confirm the header immediately returns to one truncated line.
7. Take screenshot **`04-classic-after-live-switch-back.png`**.
8. Switch **Classic View → Vertical View** once more.
9. Confirm the complete subject immediately wraps again.
10. Take screenshot **`05-vertical-after-second-live-switch.png`**.

This is the regression test for commit `c9d76b2`. Any need to reload or reselect the conversation is
a FAIL, even if the final layout looks correct afterward.

## Step 7: test the separate conversation tab

1. In the conversation header, locate the action whose tooltip says **Show this conversation in a
   new tab**.
2. Click it.
3. Confirm Thunderbird opens a separate conversation tab.
4. Confirm the complete conversation subject wraps over multiple lines at the top of that tab.
5. Confirm both synthetic messages still render normally.

Take screenshot **`06-separate-tab.png`** now.

Result is FAIL if the subject is truncated, the tab does not open, or the conversation is broken.

## Step 8: test the standalone message window

First configure Thunderbird's deterministic message-opening behavior:

1. Open **Thunderbird Settings → General**.
2. In **Reading & Display**, find **Open messages in:** and select **A new message window**.
3. Return to the synthetic folder and select the synthetic thread/message.
4. Double-click it, or press Enter. This uses the Conversations add-on's thread-pane activation path.
5. Confirm a separate standalone window opens with the Conversations view.
6. Confirm the complete conversation subject wraps over multiple lines.
7. Confirm the message content and conversation actions still render normally.

Take screenshot **`07-standalone-window.png`** now.

If Thunderbird opens its ordinary single-message reader rather than the Conversations view, record
that exact outcome as FAIL/NOT OBSERVED. Do not claim the standalone case passed.

## Step 9: record your personal observations

Fill this table yourself while the result is fresh:

| Check | Your result: PASS or FAIL | Your own observation |
| --- | --- | --- |
| Exact commit `c9d76b2…` | | |
| `npm ci` | | |
| `npm test` | | |
| `npm run build` | | |
| Thunderbird `152.0.1` | | |
| Temporary add-on `4.3.10` | | |
| Classic baseline truncates to one line | | |
| Live Classic → Vertical wraps without reload | | |
| Live Vertical → Classic truncates without reload | | |
| Second Classic → Vertical wraps without reload | | |
| Separate conversation tab wraps | | |
| Standalone window wraps | | |
| No visual breakage in messages/actions | | |

If any row fails, preserve the screenshot and exact observation. Do not keep rerunning until you get
a pass and then discard the earlier failure.

## Step 10: inspect the evidence before responding

Confirm all eight screenshots are new files you personally captured:

```text
00-thunderbird-version.png
01-temporary-addon.png
02-classic-before-switch.png
03-vertical-after-live-switch.png
04-classic-after-live-switch-back.png
05-vertical-after-second-live-switch.png
06-separate-tab.png
07-standalone-window.png
```

For every screenshot, confirm:

- only the dedicated synthetic test profile is visible;
- no personal email, account name, notification, path, token, or unrelated application is visible;
- the long conversation header is readable enough to judge wrapping versus truncation;
- the surrounding UI proves Classic, Vertical, separate-tab, or standalone context as applicable.

## Step 11: only the human updates GitHub

After the test, personally re-read the latest upstream `AGENTS.md`, `CONTRIBUTING.md`, the entire PR
diff, and the current PR body. Then make the GitHub update yourself in your own words.

The current PR body contains an AI-assistance line and a Northset receipt block. Latest upstream
`AGENTS.md` specifically requires the human to remove AI-generated footers, boilerplate, and filler.
Personally review and edit the body to comply with that requirement without concealing any material
fact about the contribution. This guide intentionally supplies no replacement wording.

The earlier public comment claimed a manual pass based on agent-run evidence. In your next response,
personally make sure the facts you state refer truthfully to this new human-run test and cannot be
mistaken for the earlier run. This guide intentionally supplies no response wording.

Your factual record should let you state the exact commit and Thunderbird version you personally
tested, which cases passed or failed, and that the live transition was performed without reload or
reselection. Do not preserve any existing PR-body claim that you did not personally verify.

Do not ask an agent to draft, edit, or post the response. The upstream policy explicitly requires
the contributor to write responses without AI-assisted language.
