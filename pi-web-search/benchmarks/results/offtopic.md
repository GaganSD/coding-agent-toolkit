# Live off-topic calibration

2026-11-28T14:01:55.832Z

Calibration and holdout were authored in separate passes by different agents. The holdout author did not see calibration examples or classifier output.
Each response was classified once. The threshold is the larger of 0.85 and the largest calibration off-topic probability on an addresses case plus 0.05.
A model passes the held-out safety gate only when it produces zero false-positive off-topic judgments.

Calibration SHA-256: `c2fc49c35f67a2b0ec8dc9ad1bf02a4ebd76358adc105a0c3737abde4d5a2cdd`
Holdout SHA-256: `e65126a839fa6eb702de776b4fa40fa188f3dbbab19b2c2fa4952e67841b6f0b`

## vercel-ai-gateway/typesafe-ai/jev

Threshold: 0.85

| Split | Addresses | Off-topic | False positives | True positives |
| --- | ---: | ---: | ---: | ---: |
| Calibration | 15 | 15 | 0 | 15 |
| Holdout | 15 | 15 | 0 | 14 |

Gate passed with zero held-out false positives.
