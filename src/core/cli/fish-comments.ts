/**
 * `fish comments` — the half of the comment system an agent drives.
 *
 * A comment lives in the file, in its own `#fish-comments` block, so an external
 * agent needs no browser: it reads the thread, reads the layer's local context,
 * writes a suggestion back, and the app picks that up on the next load. The
 * design constraint is the same one the in-app store has — never touch
 * `#design-doc` when only the conversation changed, so the payload hash, and
 * with it the identity check the writer runs, survive.
 */

import fs from "node:fs";
import type { DesignDocument, DesignElement } from "../dsl/types";
import { parseCommentsBlock, spliceCommentsBlock } from "../data-bridge";
import { parseLenientJson } from "../dsl/lenient-json";
import type { CommentThread, FishCommentsDocument, SuggestedMacroOp } from "../comments/types";

export interface CommentsCommandOptions {
  summary?: string;
  ops?: string;
  reply?: string;
  text?: string;
  /** `pending` and `list` can print one line per thread instead of JSON. */
  json?: boolean;
}

const USAGE = `  ./fish comments list <doc.fish.html> [--json]
  ./fish comments pending <doc.fish.html> [--json]
  ./fish comments context <doc.fish.html> <threadId>
  ./fish comments suggest <doc.fish.html> <threadId> --summary <text> --ops <ops.json|'[...]'>
  ./fish comments reply <doc.fish.html> <threadId> --text <text>
  ./fish comments resolve <doc.fish.html> <threadId> [--reply <text>]`;

function fail(message: string): number {
  console.error(`Error: ${message}\n\n${USAGE}`);
  return 2;
}

function readFile(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    console.error(`Error: cannot read ${path}`);
    return undefined;
  }
}

function documentOf(html: string): DesignDocument | undefined {
  const match = /<script\s+id=["']design-doc["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match || !match[1].trim()) return undefined;
  try {
    return parseLenientJson<DesignDocument>(match[1].trim());
  } catch {
    return undefined;
  }
}

function findElement(elements: DesignElement[] | undefined, id: string): DesignElement | null {
  if (!elements) return null;
  for (const el of elements) {
    if (el.id === id) return el;
    const children = (el as unknown as { children?: DesignElement[] }).children;
    const found = findElement(children, id);
    if (found) return found;
  }
  return null;
}

function findParent(elements: DesignElement[] | undefined, id: string): DesignElement | null {
  if (!elements) return null;
  for (const el of elements) {
    const children = (el as unknown as { children?: DesignElement[] }).children;
    if (!children) continue;
    if (children.some((child) => child.id === id)) return el;
    const found = findParent(children, id);
    if (found) return found;
  }
  return null;
}

function lastUserMessage(thread: CommentThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    if (thread.messages[i].author.role === "user") return thread.messages[i].content;
  }
  return "";
}

function summarize(thread: CommentThread) {
  return {
    id: thread.id,
    pageId: thread.pageId,
    status: thread.status,
    targetElementId: thread.target.elementId ?? null,
    targetName: thread.target.elementSnapshot?.name ?? null,
    canvasPoint: thread.target.canvasPoint,
    messages: thread.messages.length,
    instruction: lastUserMessage(thread),
    suggestion: thread.suggestion
      ? { summary: thread.suggestion.summary, opCount: thread.suggestion.ops.length }
      : null,
    updatedAt: thread.updatedAt
  };
}

function printThreads(threads: CommentThread[]): void {
  // Always JSON: the documented reader of this command is an agent, and a
  // "nice" table is one more format to keep in step with the fields.
  console.log(JSON.stringify(threads.map(summarize), null, 2));
}


function writeComments(path: string, html: string, comments: FishCommentsDocument): boolean {
  const next = spliceCommentsBlock(html, comments);
  if (next === html) return false;
  fs.writeFileSync(path, next, "utf-8");
  return true;
}

export function commentsCommand(args: string[], opts: CommentsCommandOptions = {}): number {
  const [action, filePath, threadId] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (!filePath) return fail(`${action} needs a document (.fish.html)`);

  const html = readFile(filePath);
  if (html === undefined) return 2;

  const comments = parseCommentsBlock(html);

  if (action === "list" || action === "pending") {
    const threads =
      action === "pending"
        ? comments.threads.filter((thread) => thread.status === "open")
        : comments.threads;
    printThreads(threads);
    return 0;
  }

  if (!threadId) return fail(`${action} needs a threadId`);
  const thread = comments.threads.find((item) => item.id === threadId);
  if (!thread) {
    console.error(`Error: thread ${threadId} not found in ${filePath}`);
    return 1;
  }

  if (action === "context") {
    const doc = documentOf(html);
    const page = doc?.pages?.find((p) => p.id === thread.pageId) ?? doc?.pages?.[0];
    const elements = page?.children;
    const target = thread.target.elementId ? findElement(elements, thread.target.elementId) : null;
    const parent = thread.target.elementId ? findParent(elements, thread.target.elementId) : null;
    const children = (target as unknown as { children?: DesignElement[] })?.children ?? [];
    const siblingsPool = (parent as unknown as { children?: DesignElement[] })?.children ?? elements ?? [];

    console.log(
      JSON.stringify(
        {
          threadId: thread.id,
          pageId: thread.pageId,
          instruction: lastUserMessage(thread),
          conversation: thread.messages.map((message) => ({
            role: message.author.role,
            name: message.author.name,
            content: message.content
          })),
          target,
          parent: parent
            ? {
                id: parent.id,
                type: parent.type,
                name: parent.name,
                layout: (parent as unknown as { layout?: unknown }).layout,
                width: parent.width,
                height: parent.height
              }
            : null,
          children,
          siblings: siblingsPool
            .filter((sibling) => sibling.id !== thread.target.elementId)
            .map((sibling) => ({ id: sibling.id, type: sibling.type, name: sibling.name })),
          tokens: {
            colors: doc?.tokens?.filter((token) => token.type === "color").map((token) => token.name) ?? [],
            radii: ["4px", "8px", "12px", "16px", "24px", "9999px"]
          },
          status: thread.status
        },
        null,
        2
      )
    );
    return 0;
  }

  if (action === "suggest") {
    if (!opts.summary || !opts.ops) return fail("suggest needs --summary and --ops");

    let parsedOps: unknown;
    try {
      const raw = fs.existsSync(opts.ops) ? fs.readFileSync(opts.ops, "utf-8") : opts.ops;
      parsedOps = JSON.parse(raw);
    } catch (err) {
      return fail(`--ops is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ops = (Array.isArray(parsedOps) ? parsedOps : (parsedOps as { ops?: unknown }).ops) as
      | SuggestedMacroOp[]
      | undefined;
    if (!Array.isArray(ops)) return fail("--ops must be an array of ops, or { ops: [...] }");

    thread.status = "suggested";
    thread.suggestion = {
      summary: opts.summary,
      ops,
      createdAt: new Date().toISOString()
    };
    thread.updatedAt = new Date().toISOString();
    // A suggestion answers the user's last instruction, so it is written as the
    // AI's own message too: the thread has to read as a conversation after a
    // reload, not as a status flag with nothing behind it.
    thread.messages.push({
      id: `msg_${Date.now()}`,
      author: { id: "ai", name: "AI Assistant", role: "ai" },
      content: opts.summary,
      createdAt: new Date().toISOString()
    });
    writeComments(filePath, html, comments);
    console.log(`Suggested ${ops.length} op(s) on ${threadId}.`);
    return 0;
  }

  if (action === "reply") {
    if (!opts.text) return fail("reply needs --text");
    thread.messages.push({
      id: `msg_${Date.now()}`,
      author: { id: "ai", name: "AI Assistant", role: "ai" },
      content: opts.text,
      createdAt: new Date().toISOString()
    });
    thread.updatedAt = new Date().toISOString();
    writeComments(filePath, html, comments);
    console.log(`Replied to ${threadId}.`);
    return 0;
  }

  if (action === "resolve") {
    thread.status = "resolved";
    thread.updatedAt = new Date().toISOString();
    if (opts.reply) {
      thread.messages.push({
        id: `msg_${Date.now()}`,
        author: { id: "ai", name: "AI Assistant", role: "ai" },
        content: opts.reply,
        createdAt: new Date().toISOString()
      });
    }
    writeComments(filePath, html, comments);
    console.log(`Resolved ${threadId}.`);
    return 0;
  }

  return fail(`unknown comments action "${action}"`);
}

export const COMMENTS_USAGE = USAGE;
