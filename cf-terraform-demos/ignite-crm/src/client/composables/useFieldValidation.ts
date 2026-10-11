import * as v from 'valibot';
/**
 * @file Shared browser-side validation through the exact Valibot request schema used by both
 *   Workers. Fields validate on blur, then revalidate as the user corrects an invalid value. A
 *   submit validates everything; untouched fields never nag while the user is still typing.
 */
import { reactive, shallowRef, type ComputedRef, computed } from 'vue';

/**
 * Browser form validation state and actions.
 */
export interface FieldValidation {
  /**
   * Visible, local field messages.
   */
  readonly errors: ComputedRef<Readonly<Record<string, string>>>;
  /**
   * Validate a field after it loses focus.
   */
  blur(field: string): void;
  /**
   * Validate the whole form and reveal all failures.
   */
  submit(): boolean;
}

/**
 * Validate a draft using the same Valibot schema used for its API request. A mapper can translate a
 * form-only representation (for example currency text) to its wire shape.
 *
 * @param schema The shared API request schema.
 * @param input Returns the current candidate request body.
 * @param aliases Optional mapping of wire error paths to form field names.
 * @returns The error state, blur handler, and submit guard.
 */
export function useFieldValidation(
  schema: v.GenericSchema,
  input: () => unknown,
  aliases: Readonly<Record<string, string>> = {}
): FieldValidation {
  const touched = reactive(new Set<string>());
  const submitted = shallowRef(false);
  const issues = computed(() => {
    const result = v.safeParse(schema, input());
    if (result.success) return {};
    const errors: Record<string, string> = {};
    for (const issue of result.issues) {
      const key = v.getDotPath(issue) ?? '';
      const field = aliases[key] ?? key;
      if (field !== '' && errors[field] === undefined) errors[field] = issue.message;
    }
    return errors;
  });
  const errors = computed(() =>
    Object.fromEntries(
      Object.entries(issues.value).filter(([field]) => submitted.value || touched.has(field))
    )
  );
  function blur(field: string): void {
    touched.add(field);
  }
  function submit(): boolean {
    submitted.value = true;
    return Object.keys(issues.value).length === 0;
  }
  // Once a field is corrected, it stops showing an error. It is still touched, so a later invalid
  // edit is announced immediately, instead of waiting for another blur.
  return { errors, blur, submit };
}
