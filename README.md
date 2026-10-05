# WhatsApp CR Bot

A Node.js WhatsApp bot built with Baileys. Copy or fork this project, set your
group IDs and replies, link a WhatsApp account, then run it on a machine that
can stay online.

> This version responds to commands; it does not schedule announcements.

## Setup

Requirements: Node.js 18 or newer and a WhatsApp account that can join your
groups.

```bash
git clone <your-repository-url>
cd <your-project-folder>
npm install
```

1. Set `BOT_ADMIN_USER_JIDS` in the bot process environment before its first
   start to bootstrap the admin list. Use your WhatsApp JID; multiple JIDs can
   be comma-separated. PM2 and systemd can set this variable. This project does
   not load `.env` files.
2. Start once with `node index.js`. Scan the QR code from WhatsApp's
   **Settings > Linked devices**. The bot prints the group names and JIDs it can
   see; copy the JIDs for your groups.
3. In `index.js`, replace `NOTICE_GROUP_JID`, `DISCUSSION_GROUP_JID`, and
   `MOD_GROUP_JID` with your group JIDs. Group JIDs end in `@g.us`.
4. Edit `bot-data.json` to set replies, images, resources, and quiz questions.
   Put image files in `assets/` and point to them from the `images` object.
5. Restart with `node index.js` to use your group configuration.

The bot must be a member of each group where it should answer. Changes to
`bot-data.json` take effect without restarting. The `auth_session/` and
`bot-state.json` files are local state and should not be committed. Keep
`auth_session/` private; it contains WhatsApp credentials.

## Important Files

- `index.js`: bot logic, command handling, WhatsApp session bootstrap, and
  automation commands.
- `bot-data.json`: message replies, images, resources, and quiz questions.
- `bot-state.json`: runtime state such as quiz scores, CSE game balances and
  daily tries, trusted mod groups, and bot admin settings.
- `auth_session/`: local Baileys session data and credentials.
- `assets/`: images that the bot can send for replies like `examtime`.

## Common Setup Notes

- The bot only reads `.env` files indirectly via the process environment; it does
  not automatically load `.env` files itself.
- `NOTICE_GROUP_JID`, `DISCUSSION_GROUP_JID`, and `MOD_GROUP_JID` are constants
  in `index.js`. Update them to match the WhatsApp groups you want the bot to
  monitor.
- After the first successful QR scan, the bot logs the group IDs it can reach;
  use those values when wiring up the groups you actually want to use.
- The bot stores its runtime state in `bot-state.json` and persists changes as it
  handles commands.

## Commands

| Command | Access | Purpose |
| --- | --- | --- |
| `CR` | Notice, Discussion, mod groups, admins | Send the default reply |
| `.cr <request>` | Chats the bot can receive messages from | Ask Hermes to select and run one allowed CR command |
| `CR menu` | Notice, Discussion, mod groups, admins | Show academic, bus, and resource shortcuts |
| `CR <name>` | Notice, Discussion, mod groups, admins | Send a configured text or image reply |
| `CR help` | Supported groups | Show the short guide or, in a mod group, the full manual |
| `CR meme` | Notice, Discussion, mod groups, admins | Send a random G-rated GIPHY GIF |
| `CR myid` | Anyone who can message the bot | Show your own WhatsApp JID |
| `CR rsrc` | Notice, Discussion, mod groups, admins | Browse resources and see which links are available |
| `CR rsrc <subject>` | Notice, Discussion, mod groups, admins | Open a resource directly, such as `CR rsrc DS` |
| `CR rsrc set <subject> <https://link>` | Mod groups, bot admins | Add a subject or replace its resource link |
| `CR games` | Notice, Discussion, mod groups | Show CSE game commands |
| `CR hunt`, `CR dig` | Notice, Discussion, mod groups | Play a short CSE-themed game (10 tries per member, per game, per group, daily) |
| `CR wallet`, `CR leaderboard` | Notice, Discussion, mod groups | Check game points or the group's top balances |
| `CR transfer @mention <amount>` | Notice, Discussion, mod groups | Transfer fictional game points to a member |
| `CR quiz`, `CR score` | Discussion, mod groups, admins | Start a quiz / view scores |
| `CR update <name> <text>` | Mod groups, admins | Change an existing text reply |
| `CR update examtime <text>` + image | Mod groups, admins | Update examtime text and image together |
| `CR mod list` | Mod groups, admins | List trusted mod groups |
| `CR start`, `CR stop` | Mod groups, admins | Enable or disable Discussion replies |
| `CR echo notice/discussion` | Mod groups, admins | Forward a message or attachment |
| `CR admin add/remove/list` | Bot admins only | Manage bot admins |
| `CR mod add/remove` | Bot admins only | Manage trusted mod groups |
| `CR block/unblock` | Bot admins only | Restrict CR commands in Discussion/mod groups |
| `CR run <shell command>` | Bot admins only | Run a server command and return its output |

Use `CR help` in the Discussion group for its smaller command guide. Use it in
a mod group for the full manual, including admin-only commands.

### Hermes natural-language commands

Set `HERMES_API_URL`, `HERMES_API_KEY`, and `HERMES_MODEL` in the bot process
environment to enable requests such as:

```text
.cr give the class routine
```

The integration expects an OpenAI-compatible Chat Completions endpoint, with
`HERMES_API_URL` set to its full URL (for example,
`https://your-hermes-host/v1/chat/completions`). The bot sends a bearer token
and expects `choices[0].message.content` to contain exactly one JSON object:
`{"command":"routine"}` or `{"command":null}`. Hermes selects from a strict
allowlist built from configured reply/image command names and supported
non-admin commands. The bot rejects other selections and routes accepted
commands through its regular handler, preserving sender and group permissions.
Hermes cannot select privileged commands, shell commands, or commands that
require arbitrary arguments (such as point transfers). If no command matches,
the bot says so rather than executing generated text.

The natural-language request is sent to the configured Hermes API. Do not
include private information in these requests. The configured `routine` reply
in `bot-data.json` is a placeholder; replace it with the class routine before
using this example. The integration makes outbound requests only and does not
open a webhook endpoint on the bot.

Use `CR menu` for academic shortcuts, bus schedules, study resources, CSE
mini-games, quiz commands, and GIFs. `CR help` in the Discussion group presents
these as separate sections, with a dedicated game guide. In the resource
browser, choose a listed number or request a subject directly with
`CR rsrc <subject>`; for example, `CR rsrc GEED`. Links that have not been
added yet are marked "coming soon" and return a clear unavailable message
rather than a placeholder link.

In a configured mod group, add a link for an existing subject or create a new
subject with:

```text
CR rsrc set DS https://drive.google.com/drive/folders/...
CR rsrc set Operating Systems https://example.com/os-materials
```

The subject match is case-insensitive; setting an existing subject replaces
its link, while a new subject is added to the resource browser. Only HTTP and
HTTPS links are accepted. Bot admins can use this command from any chat the
bot receives.

### Random GIFs via GIPHY

`CR meme` fetches a random GIF tagged `meme` from [GIPHY's Random
endpoint](https://developers.giphy.com/docs/api/endpoint/#random) and sends its
MP4 rendition as an animated GIF. Results are restricted to G-rated content.
Create an API key in the [GIPHY Developers
Dashboard](https://developers.giphy.com/dashboard/).

To add the key directly in the code, open `index.js` and find this line near
the top of the file:

```js
const GIPHY_API_KEY_IN_CODE = 'PASTE_YOUR_GIPHY_API_KEY_HERE';
```

Replace the placeholder with your key, keeping the quotes, then save and
restart the bot. Alternatively, set `GIPHY_API_KEY` in the bot process
environment; that value takes priority over the in-code key. `GIPHY_TAG` is
also optional and defaults to `meme`.

**Security:** a real key in `index.js` can be exposed if you commit or share the
file. Keep your key private and do not commit the edited file with the real key;
using a process environment variable is safer, especially for shared
repositories and hosted services. This project does not load `.env` files.

The bot has no local cooldown, so repeated requests use the API key's GIPHY
quota. If your key is on GIPHY's 100-requests-per-hour beta tier, that quota is
shared by all group members; check the developer dashboard for your key's
current limit. Requests have a 15-second timeout, and MP4 downloads are limited
to 8 MB.

### Examtime Image

In a mod group, attach a JPEG, PNG, or WebP image and caption it with the new
reply text:

```text
CR update examtime Next exam: October 8 at 9:30 AM
```

`CR examtime` sends one image with that text as its caption. Use the caption
`CR update examtime` to replace only the image. The bot removes the previous
image it saved for this command.

### CSE Mini-Games

Use `CR games` to see the game guide. Each member can play `CR hunt` or `CR dig`
up to 10 times each in each group per day. Daily attempts reset at midnight
according to the bot host's local time. Balances and attempt limits are
separate in each group.

Each game has 14 weighted, CSE-themed outcomes, including 10 additional
outcomes for hunt and 10 for dig. Each outcome awards 0–60 **CSE Coins** (`🪙`).
`CR wallet` shows your balance and remaining tries; `CR leaderboard` shows the
group's top five balances. To give coins to another member, mention exactly one
person:

```text
CR transfer @mention 25
```

Transfers require enough coins, cannot target yourself, and are saved with
game state. CSE Coins are fictional and group-only: they cannot be wagered,
bought, redeemed, or exchanged for money. Game balances and attempt counts are
stored in `bot-state.json`, separately from quiz scores.

### Admins And Mod Groups

The initial admin list is bootstrapped from `BOT_ADMIN_USER_JIDS` only when
`bot-state.json` has no saved `botAdminUserJids` list. After that, bot admins
can manage the list with:

```text
CR admin add @mention
CR admin remove @mention
CR admin list
```

You can also use a phone number or WhatsApp JID. The last admin cannot be
removed. Mod groups give their members regular mod tools; sensitive actions
such as adding/removing groups, blocking users, changing admins, and running
shell commands are reserved for bot admins.

### Shell Command Safety

`CR run` executes commands with the permissions of the bot process. It stops
commands after 20 seconds and limits output to 5,000 characters. Do not add
untrusted admins, and do not run the bot as root or an administrator. `pm2 stop`
is explicitly refused because it would stop the bot.

## Keep It Running

For local testing:

```bash
node index.js
```

For a VPS, run it with a process manager such as PM2 or systemd and keep the
`BOT_ADMIN_USER_JIDS` environment variable in that service's configuration.
Run the automated game tests and check JavaScript syntax with:

```bash
npm test
node --check index.js
```