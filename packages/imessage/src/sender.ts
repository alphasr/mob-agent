import { execFile } from 'node:child_process';
import type { Thread } from '@textagent/core';

/** Sends one text to one thread. Swappable so the channel can be tested without Messages. */
export type IMessageSender = (thread: Thread, text: string) => Promise<void>;

export class AutomationPermissionError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'Not allowed to control Messages. Allow it in System Settings → Privacy & Security → Automation ' +
        '(enable "Messages" under your terminal, IDE or node), then restart the agent.',
      options,
    );
    this.name = 'AutomationPermissionError';
  }
}

export class SendError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code: number | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SendError';
    this.code = code;
  }
}

/**
 * Text and ids arrive as argv, never spliced into the script source, so no message
 * content can change what the script does. Tries the chat guid first (works for groups
 * and DMs); for a DM whose chat Messages no longer knows, falls back to the buddy.
 */
const SEND_SCRIPT = [
  'on run argv',
  '  set chatGuid to item 1 of argv',
  '  set recipient to item 2 of argv',
  '  set messageText to item 3 of argv',
  '  tell application "Messages"',
  '    try',
  '      send messageText to chat id chatGuid',
  '    on error errMsg number errNum',
  '      if recipient is "" or errNum is -1743 then error errMsg number errNum',
  '      set targetAccount to 1st account whose service type = iMessage',
  '      send messageText to participant recipient of targetAccount',
  '    end try',
  '  end tell',
  'end run',
];

/** osascript wants one `-e` per line; everything after the script is argv. */
export function osascriptArgs(thread: Thread, text: string): string[] {
  return [...SEND_SCRIPT.flatMap((line) => ['-e', line]), thread.id, dmRecipient(thread) ?? '', text];
}

/** 'iMessage;-;+15550001' → '+15550001'. Groups ('iMessage;+;chat…') have no single recipient. */
export function dmRecipient(thread: Thread): string | undefined {
  if (thread.isGroup) return undefined;
  const parts = thread.id.split(';-;');
  return parts.length === 2 ? parts[1] : undefined;
}

export const appleScriptSender: IMessageSender = (thread, text) =>
  new Promise((resolve, reject) => {
    execFile('osascript', osascriptArgs(thread, text), { timeout: 15_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const code = /\((-?\d+)\)\s*$/.exec(stderr.trim())?.[1];
      const errNum = code === undefined ? undefined : Number(code);
      if (errNum === -1743) return reject(new AutomationPermissionError({ cause: error }));
      const detail = stderr.trim().replace(/^.*execution error:\s*/, '') || error.message;
      reject(new SendError(`iMessage send to ${thread.id} failed: ${detail}`, errNum, { cause: error }));
    });
  });
