/**
 * @file A guard on the one kind of statement this demo must not make: a reassurance about data
 *   retention that it is not in a position to keep. The panels used to tell visitors their prompt
 *   was "not stored". It was removed because it is not this application's claim to make: payload
 *   retention is AI Gateway's behaviour, the AI binding exposes no payload-collection option so the
 *   header this demo sends cannot be confirmed to have taken effect, and the gateway's own
 *   documentation states that a log can include the prompt and response. An unverifiable privacy
 *   promise is worse than none, because a visitor may act on it. This guard is written against
 *   every panel rather than the two that exist today, so a panel added in a later phase inherits
 *   it.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_DESCRIPTORS } from '../../src/shared/tasks';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

describe('privacy claims across every panel', () => {
  /**
   * Lists every view and feature file that renders visitor-facing prose.
   *
   * @returns Repository-relative paths.
   */
  async function proseFiles(): Promise<string[]> {
    const roots = ['src/client/views', 'src/client/features', 'src/client/components'];
    const files: string[] = [];

    for (const root of roots) {
      const stack = [path.join(demoRoot, root)];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) {
          break;
        }
        for (const dirent of await readdir(current, { withFileTypes: true })) {
          const absolute = path.join(current, dirent.name);
          if (dirent.isDirectory()) {
            stack.push(absolute);
          } else if (dirent.name.endsWith('.vue')) {
            files.push(path.relative(demoRoot, absolute));
          }
        }
      }
    }

    return files;
  }

  /**
   * Strips HTML comments so an explanation of the rule is not mistaken for a breach of it.
   *
   * @param source File contents.
   * @returns The same text with comments removed.
   */
  function stripTemplateComments(source: string): string {
    // Only HTML comments. A `/* ... */` sweep also matched from a CSS comment in `<style>` to the
    // end of the next one, which silently swallowed the template prose in between and made this
    // guard assert against a near-empty string.
    return source.replaceAll(/<!--[\s\S]*?-->/gu, '');
  }

  // A panel must not tell a visitor their prompt is unretained. Payload retention belongs to AI
  // Gateway, whose documentation says a log can include the prompt; the AI binding exposes no
  // payload-collection option, so the request header this demo sends cannot even be confirmed to
  // have taken effect. An unverifiable reassurance about someone else's data is worse than none,
  // because a visitor may act on it.
  //
  // View Tokens is the sole exception and needs no exemption here: it performs no inference at all,
  // so it has no prompt to retain and says so in different words.
  it('no panel promises that a prompt or output is unretained', async () => {
    const offenders: string[] = [];

    for (const file of await proseFiles()) {
      const contents = stripTemplateComments(await readFile(path.join(demoRoot, file), 'utf8'));

      if (/\b(?:are|is)\s+not\s+(?:stored|retained)\b/iu.test(contents)) {
        offenders.push(file);
      }
      if (/\bnever\s+(?:stored|retained)\b/iu.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Every panel that spends credit has to warn instead. The warning is the honest replacement for
  // the reassurance, so its absence would leave a visitor with neither.
  it('every inference panel warns that prompts should be assumed logged', async () => {
    const inferenceViews = TASK_DESCRIPTORS.filter(
      (task) => task.availability === 'available' && task.gateway === 'required'
    );

    const files = await proseFiles();

    for (const task of inferenceViews) {
      // Matched against the route view specifically — `src/client/views/<Task>View.vue` — rather
      // than any file whose name contains the task. A loose match also caught
      // `features/chat/ChatTranscript.vue`, which renders the conversation and has no business
      // carrying the panel's disclosure.
      const expected = `${task.id
        .split('-')
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join('')}View.vue`;
      const view = files.find((file) => file === `src/client/views/${expected}`);

      expect(view, `${task.name} has a route view at src/client/views/${expected}`).toBeDefined();
      if (view === undefined) {
        continue;
      }

      // Whitespace is collapsed before matching: the prose is wrapped to the line length the
      // formatter enforces, so "Assume your\n        prompt" would otherwise fail a regex that
      // expects a single space. Matching the rendered sentence rather than its source layout is
      // what makes this guard test the claim instead of the line wrapping.
      const contents = stripTemplateComments(
        await readFile(path.join(demoRoot, view), 'utf8')
      ).replaceAll(/\s+/gu, ' ');

      // "Assume your <something> is logged" rather than "assume your prompt": a panel's input is
      // not always a prompt. Describe Image's is a picture, and later phases will submit audio and
      // video. Pinning the noun would have forced those panels to describe a visitor's upload as a
      // "prompt", which is the guard dictating the prose rather than checking it.
      expect(contents, `${task.name} warns that its input is logged`).toMatch(
        /assume your [^.]*\b(?:is|are) logged/iu
      );
      expect(contents, `${task.name} advises against confidential input`).toMatch(
        /nothing confidential|anything confidential/iu
      );
    }
  });
});
