# Board recognition models

Screenshot → FEN. Both models come from **[Chess_diagram_to_FEN](https://github.com/tsoj/Chess_diagram_to_FEN)**
by Jost Triller, **MIT licence** (see `LICENSE.Chess_diagram_to_FEN.txt`). They are the upstream chess
checkpoints converted to ONNX — no retraining, no architecture change.

| File | From | Job | Size |
|---|---|---|---|
| `bbox.onnx` | `best_model_quad_0.971` | find the board in a screenshot (LR-ASPP MobileNetV3 segmentation, 512×512 in, mask out) | 12 MB, fp32 |
| `position.onnx` | `best_model_position_0.977` | read the 64 squares (ConvNeXt-Tiny ×2 + attention, 256×256 board in, [64,13] out) | 59 MB, int8 |

`position` is dynamic-int8 quantised (232 MB → 59 MB). Verified argmax-identical to fp32 on every test
below, so the quantisation costs no accuracy. `bbox` is left fp32: quantising it drifted the mask
logits by ~4.0, which can flip pixels at the board edge, and it only saves 9 MB.

Class order is `("P","N","B","R","Q","K","p","n","b","r","q","k")` then empty — from upstream
`src/games.py`. Input is plain RGB scaled to 0..1, NCHW, **no ImageNet mean/std normalisation**.

## Verified
ONNX vs PyTorch: max diff 3.6e-07 (position), 7.2e-05 (bbox); all 64 squares argmax-identical.
End-to-end FEN recovery on rendered boards was exact for every case tried: 4 positions × 3 piece sets,
4 board colour schemes, source sizes 128–800px downscaled to 256, Gaussian blur, JPEG q40 and q20, and
crops misaligned by 6px and 16px (a quarter square).
