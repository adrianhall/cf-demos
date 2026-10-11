# Enterprise Broadcast 

**Status:** Project introduction; detailed specification to follow.
**Working title:** Town Hall. Final application name to be decided.

## Introduction, Requirements, and Observations

## 1. Introduction

I am building a collection of demo applications to demonstrate the capabilities of Cloudflare’s Developer Platform. Each application focuses on a particular capability, or shows how several capabilities work together in a realistic application.

The portfolio currently includes Playground for AI capabilities, Chat for Durable Objects, Todo for D1, URL Shortener for KV, and Architect for bringing several capabilities together. Ignite CRM is in progress, demonstrating D1 with a separate RPC binding for data activities. Codeflare is planned next, demonstrating Artifacts and the Sandbox SDK.

This project adds an enterprise video broadcast experience to the portfolio, demonstrating RealtimeKit, WebRTC connectivity—including STUN and TURN—and potentially Stream Live for a larger watch-only audience. Workers AI would provide translation of the live transcript, with Workers and potentially Durable Objects coordinating application state and transcript delivery.

The intended use case is an enterprise town hall, live briefing, training session, or product presentation. A presenter has a Zoom-like experience for camera, microphone, and sharing a window, tab, or screen. Viewers watch the presentation and follow a live transcript in their preferred language. A viewer can mute the original audio and continue following the video through the translated transcript.

This is not intended to be a complete Zoom replacement. The initial focus is a small number of presenters, a watch-only audience, and an accessible multilingual viewing experience.

## 2. Experience and Product Intent

### Presenter experience

The presenter should be able to join a protected presenter session, select their camera and microphone, and control those devices during the broadcast. Screen sharing should support the sources offered by the browser, subject to user permission and platform limitations.

The presenter should control the presentation layout. Candidate layouts are camera only, shared presentation with camera picture-in-picture, and camera and presentation side by side. Viewers should follow the selected stage layout rather than independently arranging the presentation.

### Viewer experience

The viewer sees the live video alongside an auto-scrolling transcript panel. The presenter’s original audio remains available, but can be muted independently of the transcript. The transcript is text, not translated or synthesized speech.

Viewers choose a transcript language. When that language matches the presenter’s spoken language, the original transcription is shown without a translation step. Otherwise, the application translates the transcript into the chosen language.

The panel retains earlier paragraphs so viewers can review something they missed. The current paragraph should be visually emphasized. Scrolling back should suspend automatic following, with a Follow live control to resume it. On smaller screens, the transcript should appear below the video rather than squeezing beside it.

## 3. Initial Requirements

### Broadcast and roles

- Support one presenter and multiple watch-only viewers in the initial demo.
- Use RealtimeKit for presenter camera, microphone, and screen-sharing capabilities.
- Enforce presenter and viewer permissions in the backend and media configuration, not merely by hiding interface controls.
- Provide a viewer join link and protected presenter access.
- Allow the presenter to turn camera and microphone on or off and start or stop screen sharing.
- Provide a consistent, presenter-controlled stage layout across viewers.
- Show clear broadcast states, such as waiting for the presenter, live, disconnected, and ended.

### Video and transcript interface

- Show the presentation or presenter video as the primary content.
- Display the live transcript beside the video on desktop and below it on mobile.
- Let each viewer mute or unmute the original audio without interrupting video or transcript updates.
- Provide transcript language selection and transcript show/hide controls.
- Retain earlier transcript paragraphs within the session and allow manual review.
- Provide automatic scrolling, current-paragraph emphasis, and a Follow live control.

### Transcription and translation

- Transcribe the presenter’s audio using RealtimeKit’s managed real-time transcription, subject to supported spoken languages and account availability.
- Show original-language captions and offer a small, explicitly supported set of translation languages; three target languages are a reasonable starting scope.
- Use interim transcription for fast original-language feedback where useful, and finalized segments as the initial translation input.
- Translate each finalized segment once per active target language, then share the result among viewers using that language.
- Preserve segment ordering and prevent duplicate transcript entries during retries or reconnections.
- Consider a small amount of preceding transcript context to improve translation consistency.
- Fall back visibly to the original-language text when translation is unavailable or fails.
- Align transcript display with the video being watched, particularly when using Stream Live.

### Platform demonstration and access

- Expose a small connection-insights panel where supported: connection status, round-trip time, packet loss, bitrate, and whether a TURN relay is actually being used.
- Clearly distinguish the WebRTC presenter or participant path from the Stream audience delivery path.
- Keep Cloudflare administrative credentials and stream keys server-side.
- Make the interface usable on both desktop and mobile.
- Make it clear that transcription is active; retention and access policies must be decided before using sensitive enterprise content.

## 4. Architectural Observations

### RealtimeKit is a suitable foundation

RealtimeKit provides the core meeting capabilities, media routing, and webinar role model. Its webinar configuration supports presenters and viewers, including strictly view-only permissions. This avoids implementing a WebRTC meeting system from scratch.

For a modest demo audience, viewers can participate directly in an RTK webinar as watch-only participants. This is the simplest initial delivery model and keeps the demonstration centered on RealtimeKit.

### RealtimeKit and Stream Live can serve different parts of the same application

A hybrid model uses RealtimeKit for the presenter and invited speakers, then sends a composed broadcast to Stream Live for the watch-only audience. Stream delivers that broadcast through HLS or DASH, using the Stream player or a compatible player.

RTK documents RTMP output configuration through its recording and meeting configuration APIs, and its SDK exposes livestream start and stop methods. Stream Live provides an ingest URL and stream key. These capabilities suggest the following pipeline:

Presenters → RealtimeKit over WebRTC → composed broadcast output → Stream Live → watch-only viewers.

This is a configured integration, not an automatic conversion of RTK participants into Stream viewers. Before adopting it, a small proof of concept should validate the exact RTK output configuration, compatibility with Stream’s RTMPS ingest, output layout, lifecycle controls, and billing implications. The individual capabilities are documented more clearly than the complete end-to-end setup.

For a very large, primarily watch-only audience, Stream Live is the more appropriate audience-delivery option. It also provides a path to replay recordings. RTK-only delivery remains a sensible first milestone.

### Media tracks and broadcast layout are different concerns

Sharing a window does not mean viewers automatically see the presenter’s complete application interface. RealtimeKit carries audio, camera video, and shared-screen media; the application determines how those tracks are displayed.

With RTK-only viewers, shared stage state can keep viewer layouts consistent without server-side video composition. With Stream delivery, the composed output determines the audience’s layout. Custom stage behavior must therefore be tested separately for each delivery mode.

### STUN and TURN are connectivity mechanisms

STUN supports address discovery during WebRTC connection negotiation. TURN relays media when network conditions require it. RealtimeKit configures Cloudflare TURN, so a separate TURN integration is not necessary merely to make RTK work.

A connection-insights panel makes otherwise invisible networking capabilities demonstrable. It must report observed behavior rather than imply that every connection uses TURN. A deliberate relay demonstration requires verification of SDK controls and statistics, followed by testing under restrictive network conditions.

Ordinary Stream HLS/DASH viewers do not use the RTK WebRTC connectivity path. In a hybrid broadcast, the STUN/TURN demonstration belongs on the presenter or interactive participant side.

### Transcription is not translation

RealtimeKit’s transcription configuration specifies the language being spoken. It does not automatically produce a different transcript language for every viewer. Translation is a separate application workflow, for example using Workers AI.

A Worker and potentially a Durable Object per broadcast could coordinate active language preferences, finalized transcript segments, translation deduplication, ordering, and delivery. These are architectural candidates, not decisions locked by this introduction. The detailed specification must also establish how transcript events reach that coordinator; browser SDK events are not themselves a backend subscription.

Translation work should scale with the number of active languages rather than the number of viewers. Twenty viewers selecting Spanish should receive the same translated segment, not trigger twenty translations.

### Transcript timing remains important in a side panel

A side-panel transcript is more forgiving than word-timed subtitles, but it should still follow the video the viewer is watching. Stream encoding and player buffering introduce delay relative to the RTK session. Sending transcript text immediately may reveal a point before the viewer hears or sees it.

Timestamped segments, buffering, and playback-timeline alignment should therefore be investigated for the Stream mode. A fixed delay may be useful for an early experiment, but is not a robust synchronization solution for viewers with differing playback delays.

## 5. Scope Boundaries and Constraints

- The first version is a broadcast demo, not a general-purpose video-conferencing replacement.
- Translation is text only. Live translated spoken audio and speech synthesis are out of scope.
- Transcription and translation introduce processing delay and may contain errors, particularly for technical terms and names. Do not promise perfectly synchronized interpretation.
- Supported real-time transcription languages must be checked separately from translation-model language coverage.
- Screen capture choices and shared system audio vary by browser and operating system. Do not assume every platform can share every source or its audio.
- A side-panel transcript is not automatically a caption track embedded in the Stream video or its recording.
- Account setup, service limits, transcription charges, translation usage, RTK participant usage, broadcast-output costs, and Stream delivery/storage charges need validation before a public or high-volume demo.
- Sensitive workloads require explicit review of transcription processing, managed storage, retention, access controls, and recording behavior.

## 6. Suggested Delivery Sequence

### Initial demo

Deliver one presenter, watch-only RTK viewers, camera and microphone controls, screen sharing, a consistent stage layout, original-language transcription, three selectable translation languages, viewer audio controls, and a responsive transcript panel. Add connection insights where the SDK supports reliable reporting.

### Broadcast extension

Validate RTK-to-Stream output, introduce Stream-based viewer playback, and implement transcript distribution and timing for that playback path. Demonstrate the difference between interactive WebRTC participation and scalable watch-only delivery.

### Later possibilities

Moderated Q&A, inviting a viewer onto the stage, multiple presenters, recordings, replay with synchronized translated transcripts, and searchable transcript history are potential extensions rather than initial requirements.

## 7. Questions to Resolve in the Specification

- What is the final application name and intended audience size?
- Is RTK-only delivery the first release, or is Stream delivery required from the outset?
- Which presenter language and three translation languages should be demonstrated?
- How will presenter identity and authorization be enforced?
- How will live transcript events reach the translation coordinator reliably?
- Which layouts should be supported, and how will the composed Stream output reproduce them?
- How will caption timestamps map to the Stream playback timeline?
- What should happen when a viewer joins late, reconnects, or changes language?
- Will transcripts and recordings be retained, and under what access and retention policy?
- What connection diagnostics can be obtained reliably, and how will TURN usage be demonstrated?

## 8. Reference Documentation

- [Cloudflare Realtime overview](https://developers.cloudflare.com/realtime/)
- [RealtimeKit webinar setup and roles](https://developers.cloudflare.com/realtime/realtimekit/webinar/)
- [RealtimeKit transcription](https://developers.cloudflare.com/realtime/realtimekit/ai/transcription/)
- [RealtimeKit livestream SDK methods](https://developers.cloudflare.com/realtime/realtimekit/core/api-reference/rtklivestream/)
- [RealtimeKit Start Recording API, including RTMP output configuration](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/recordings/methods/start_recordings/)
- [Stream Live overview](https://developers.cloudflare.com/stream/stream-live/)

This document captures the project intent, initial requirements, and observations discussed so far. It deliberately precedes the detailed specification and does not fix API contracts, schemas, model selection, or implementation details.
