# Integrating an application

`examples/feedback-capture.ts` demonstrates synthetic local feedback capture.
Loopiter connects to an application through developer-owned instrumentation and adapters.

An integration should choose an authorized
namespace, version predictions, record verified operator corrections (not infer
truth from rephrasing), define a held-out evaluator, and implement a real versioned
deployment adapter with inspection/rollback. A fresh onboarding plan records
autonomous mode under the existing gates. Use `--mode recommend` when you want
proposals only. Do not
enable telemetry or model transfers for real operator conversations without an
application-owned privacy and authorization decision.
