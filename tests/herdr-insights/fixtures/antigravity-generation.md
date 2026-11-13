# Antigravity wire-format vector

`antigravity-generation.hex` is synthetic, not a captured conversation. It was
encoded and round-tripped with Google's Python `protobuf==6.33.0`, independently
of this repository's JavaScript fixture builder.

The model is `gemini-3-flash-a`, response ID `resp-1`; usage fields are
`1=1132, 2=500, 3=340, 5=16000, 9=300, 10=40`. Expected uncached input is
1632; output is 340, including 40 reasoning tokens. Unknown fields exercise
fixed32, fixed64 and the maximum uint64 without interpreting them as usage.

Model, input, total-output and cache fields agree across these public implementations;
text-output, reasoning and response-ID fields follow tokscale's documented mapping:
- [tokscale, e9af34f](https://github.com/junhoyeo/tokscale/blob/e9af34fbd805674df0181dfaa2c6820da0b2b71d/crates/tokscale-core/src/sessions/antigravity_cli.rs)
- [OpenUsage, 2fd4fb0](https://github.com/robinebers/openusage/blob/2fd4fb071f7720e2f9cee7ac52c2c9684dd96e31/Sources/OpenUsage/Providers/Antigravity/AntigravityProtoDecoder.swift)

This checks wire decoding and accounting, not compatibility with every Antigravity
version. Neither reference is an official schema; no real-session fixture is supplied.
