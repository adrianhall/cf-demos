# Follow on Requirements

## 1. Make the task types collapsible

Currently, the sidebar has headings "Generate", "Understand", "Speech", "Reason", and "Inspect".  These should be made into collapsible sections, with the default state that everything is expanded.  Include a "collapse all" and "expand all" icon pair at the top of the lists for easy management.

## 2. Indicate Cloudflare-hosted and Third-Party models

Each task type has a mix of cloudflare-hosted models and third-party models.  The third-party models require AI credits to be added to the account.  Additionally, as we were developing, we included a "phase" number pill next to the task type.

Replace the phase number pill with a set of icons.  Use the cloudflare logo for a task type that allows cloudflare-hosted models and a "3P" icon for a task type that has third-party models available.  Display these logos where the phase number pull used to be.

## 3. Document model ID

Each model is represented by its descriptive name; however, cloudflare uses a model ID instead.  In all the model drop-downs, we should provide both.  For example, in Chat, we currently show "Llama 3.3 70B (fast)", which has a model ID of `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.  We should show this as `Llama 3.3 70B (@cf/meta/llama-3.3-70b-instruct-fp8-fast)` in the model list.

## 4. Include all Cloudflare Hosted Models

We have made a deliberate decision to limit the number of models available in the demo.  However, there is a benefit to being able to use all Cloudflare-hosted models for a specific task type.  For each task type:

- Determine the list of cloudflare-hosted models that can handle the task.
- Use `cf ai run` to determine the schema shape of the model.
- Add each cloudflare-hosted model to the list of available models for the task.
- If additional work is needed to support the model, then do that work.

Summarize the work done on a per-task basis at the end of the turn.
