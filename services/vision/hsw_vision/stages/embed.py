"""Embedding stage: CLIP image embeddings (L2-normalised, 512 floats) of object crops or whole images.

The encoder is the manager's shared resident CLIP (the same one the recogniser and the segmenter use), so an
embedding of a crop is comparable with the library's text/bank scores. Crops are the recogniser's own
(`threed_vision.clip.crop_masked`: padded bbox, background painted neutral).
"""

from __future__ import annotations

import numpy as np

from hsw_vision.engines import CLIP
from hsw_vision.manager import ModelManager

MODEL = "clip-b32"
DIM = 512


def embed_images(manager: ModelManager, images: list[np.ndarray]) -> np.ndarray:
    """(N, 512) float32 rows, L2-normalised; `images` are RGB uint8 arrays (the encoder letterboxes them)."""
    if not images:
        return np.zeros((0, DIM), np.float32)
    return np.asarray(manager.call(CLIP, lambda clip: clip.images(images)), dtype=np.float32)


def embed_objects(manager: ModelManager, rgb: np.ndarray, masks: list[np.ndarray]) -> np.ndarray:
    """(N, 512) embedding of each mask's masked crop of `rgb`."""
    from threed_vision.clip import crop_masked

    return embed_images(manager, [crop_masked(rgb, mask)[0] for mask in masks])
