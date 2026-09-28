# WhatsApp Notice Bot

A WhatsApp group bot for class reminders and `CR` commands, built with
`@whiskeysockets/baileys`.

## Features

- Connects to WhatsApp Web through Baileys.
- Prints a QR code in the terminal when a new login is required.
- Saves the authenticated session in `auth_session/` so you do not scan every time.
- Lists participating group names and IDs after connecting.
- Sends a scheduled class reminder to the configured group from Sunday through Thursday at 08:30.
- Responds to `CR` commands in the configured group.
- Reconnects automatically after most connection interruptions.

## Requirements

- Node.js 18 or newer.
- A WhatsApp account that can access the target group.
- The target WhatsApp group ID, also called its JID. It ends with `@g.us`, for example:

```text
120363012345678901@g.us
```

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Phonkboisad/whatsapp-notice-bot.git
cd whatsapp-notice-bot
npm install
```

## Configuration

Open `index.js` and set `NOTICE_GROUP_JID` to the group where the bot should send reminders and process commands:

```js
const NOTICE_GROUP_JID = '120363406812832614@g.us';
```

The current scheduled announcement is defined in the `cron.schedule` callback. Update the room names, times, and message text there when the class routine changes.

The cron expression is:

```text
30 8 * * 0-4
```

This means 08:30 on Sunday through Thursday, using the machine's local timezone.

## First Login

Start the bot from the project directory:

```bash
node index.js
```

When the terminal displays the QR code, open WhatsApp on your phone and choose:

`Settings` -> `Linked devices` -> `Link a device`

Scan the terminal QR code. Once connected, the bot prints a list of groups and their IDs. The session is then saved under `auth_session/`.

If a fresh QR code is needed, stop the bot and delete `auth_session/`, then run `node index.js` again. Do not commit that directory; it contains login credentials and is ignored by Git.

## Finding a Group ID

After a successful connection, the terminal prints output similar to:

```text
Available WhatsApp groups:
test 101: 120363430226894816@g.us
```

Copy the ID ending in `@g.us` into `NOTICE_GROUP_JID`, then restart the bot.

## Commands

Commands are recognized only in the configured target group. Matching is case-insensitive.

### Default command

Send:

```text
CR
```

The bot replies:

```text
Porte jao , Distap Hcche
```

### Chained commands

The following commands read their replies from `bot-data.json`:

```text
CR classtime
CR examtime
CR special
CR assignment
CR classtest
CR labtest
```

Edit the values in `bot-data.json` each day:

```json
{
	"default": "Porte jao , Distap Hcche",
	"commands": {
		"classtime": "09:00 AM - Room 402",
		"examtime": "10:00 AM - Mathematics",
		"special": "Guest lecture today",
		"assignment": "Submit Assignment 3 by 8 PM",
		"classtest": "Class test at 11:00 AM",
		"labtest": "Lab test in Lab 2 at 2:00 PM"
	}
}
```

The bot reads `bot-data.json` whenever it receives a `CR` command, so you do not need to restart it after updating the file. Keep the JSON valid and preserve the command names. If the file cannot be read, the bot uses the default reply and logs an error in the terminal.

The command parser also accepts extra text before or after `CR`, for example:

```text
please CR classtime
```

## Running in Production

Keep the bot process running on a machine with a stable internet connection. For a simple run:

```bash
npm install
node index.js
```

The bot must remain running for scheduled messages and command replies to work. If the process stops, start it again with `node index.js`. The saved `auth_session/` allows it to reconnect without scanning again unless WhatsApp logs the device out.

## Git Workflow

Check the working tree before committing:

```bash
git status
```

Validate the JavaScript file:

```bash
node --check index.js
```

Stage, commit, and push a change:

```bash
git add index.js README.md package.json package-lock.json
git commit -m "docs: add bot setup and usage guide"
git push origin main
```

Never commit `auth_session/`, `node_modules/`, `.env`, or log files.

## Project Files

```text
index.js          Bot connection, scheduler, and command handling
bot-data.json     Daily CR replies and chained command content
package.json      Project metadata and dependencies
package-lock.json Locked dependency versions
README.md         Setup and usage guide
.gitignore        Excludes credentials, dependencies, and logs
```

