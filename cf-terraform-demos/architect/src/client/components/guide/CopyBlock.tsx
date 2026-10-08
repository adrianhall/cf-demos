import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long the copied acknowledgement stays on screen, in milliseconds.
 *
 * Long enough to be read after the eye returns to the button, short enough that a reader copying
 * two blocks in succession is not told the wrong one succeeded.
 */
const COPIED_RESET_MS = 2000;

/**
 * Outcome of a copy attempt, which is what decides the message rather than a single boolean.
 *
 * `unsupported` is a real state rather than a variant of failure. The Clipboard API is absent in an
 * insecure context — `http://` on anything but localhost, which is exactly how somebody might reach
 * a self-hosted copy of this demo — and telling that reader "copy failed" would suggest retrying
 * something that cannot work. They are told to select the text instead, which always can.
 */
type CopyStatus = 'idle' | 'copied' | 'unsupported';

/**
 * Props for {@link CopyBlock}.
 */
export interface CopyBlockProps {
  /**
   * Exact text shown in the block and written to the clipboard. The two are the same string by
   * construction, so a reader who copies by hand cannot get something different from a reader who
   * presses the button.
   */
  code: string;
  /**
   * What this block contains, used to build the copy button's accessible name.
   *
   * A page of code blocks otherwise presents a screen-reader user with a list of controls all named
   * "Copy", which is a well-known failure of exactly this pattern: the name has to say _which_
   * thing is copied.
   */
  label: string;
  /**
   * Language hint rendered as a small caption above the block, for example `JSON` or `Shell`.
   * Purely informational; omitted when the content is prose a reader types verbatim.
   */
  language?: string;
}

/**
 * A copyable block of configuration, a command, or a prompt.
 *
 * Three accessibility properties are deliberate rather than incidental.
 *
 * The control is a real `<button>`, so it is keyboard-operable and announced as a button without
 * any ARIA at all, and its accessible name includes {@link CopyBlockProps.label} so a page carrying
 * a dozen of these does not present a dozen identically-named controls.
 *
 * The result is announced rather than only shown. The button's visible text changes, which a
 * sighted reader sees, but a screen-reader user who has moved on would never learn the outcome — so
 * the same message is also written to a polite live region. "Copied" as a colour change or an icon
 * swap alone would fail WCAG 1.4.1 for the same underlying reason.
 *
 * The clipboard is treated as optional. `navigator.clipboard` is undefined in an insecure context
 * and `writeText` can be refused by permission policy, so both are handled and the block itself
 * stays selectable text in every case — the manual path is always available, which is precisely
 * what the degraded case needs.
 *
 * @param props Code, label and optional language caption; see {@link CopyBlockProps}.
 * @returns The code block and its copy control.
 */
export function CopyBlock({ code, label, language }: CopyBlockProps) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Without this, copying and then navigating away leaves a timer holding a `setState` on an
  // unmounted tree. Keyed on nothing, because the timer is per-component rather than per-copy:
  // a second copy replaces the first one's pending reset below.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  /**
   * Schedules the acknowledgement to clear, replacing any reset already pending.
   *
   * @param next Status to show until the reset fires.
   */
  const announce = useCallback((next: CopyStatus): void => {
    setStatus(next);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setStatus('idle'), COPIED_RESET_MS);
  }, []);

  /**
   * Copies the block's text, reporting whichever of the three outcomes occurred.
   *
   * @returns A promise fulfilled once the attempt has finished and its result is on screen. It
   *   never rejects: a refused or absent clipboard is a state this component renders, not an error
   *   a caller could do anything about.
   */
  const handleCopy = useCallback(async (): Promise<void> => {
    // Checked rather than assumed: in an insecure context `navigator.clipboard` is not merely
    // unusable, it is absent, so calling through it would throw a `TypeError` rather than reject.
    if (typeof navigator.clipboard?.writeText !== 'function') {
      announce('unsupported');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      announce('copied');
    } catch {
      // A refusal is reported the same way an absent API is, and for the reader's purposes it is
      // the same thing: the button cannot do it, and selecting the text can.
      announce('unsupported');
    }
  }, [announce, code]);

  const message =
    status === 'copied'
      ? `${label} copied to the clipboard.`
      : status === 'unsupported'
        ? `${label} could not be copied automatically. Select the text to copy it.`
        : '';

  return (
    <div className="copy-block">
      <div className="copy-block__bar">
        {language !== undefined && <span className="copy-block__language">{language}</span>}
        {/* An explicit label rather than a visually-hidden span appended to the visible word.
            Accessible-name computation concatenates child text nodes without reintroducing the
            whitespace between inline elements, so the span approach yields "Copythe endpoint
            URL" — a name no assistive technology reads usefully and no test can match on.

            The verb tracks the visible text so the visible label stays a substring of the
            accessible name, which is what WCAG 2.5.3 (Label in Name) requires and what lets a
            speech-input user say "Copy" and have it work. */}
        <button
          type="button"
          className="button copy-block__button"
          aria-label={`${status === 'copied' ? 'Copied' : 'Copy'} ${label}`}
          onClick={() => void handleCopy()}
        >
          {status === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* `tabIndex={0}` so a keyboard user can scroll a block that overflows horizontally. A
          scrollable region reachable only by pointer is a WCAG 2.1.1 failure, and a narrow
          viewport is exactly where these blocks scroll: a shell command or a JSON snippet cannot
          be wrapped without changing what a reader copies by eye, so `.copy-block__pre` scrolls
          instead (see `app.css`).

          The rule is correct in general — a `<pre>` is not interactive — but it cannot see that
          this one is a scroll container, which is the documented exception the WAI makes for
          exactly this case. Scoped to this line rather than disabled for the file, and paired
          with a `:focus-visible` outline so the focus stop is visible rather than silent. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className="copy-block__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
      {/* Not visually redundant with the button's own label change: a screen-reader user whose
          focus has moved on learns the outcome only from here. Polite rather than assertive,
          because a copy confirmation must not interrupt. */}
      <output className="visually-hidden">{message}</output>
    </div>
  );
}
