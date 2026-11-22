"""Optional application integrations. Importing loopiter never loads providers.

Import `observe`, `otel`, `privacy`, or `capture` directly. OpenTelemetry is not
imported unless `opentelemetry_span_exporter` is called.
"""
