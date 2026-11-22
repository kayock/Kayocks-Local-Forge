#!/bin/bash
# Re-apply the model-list cap fix after a platform rewind (survivable copy: scripts/TopBar.modelcap.fixed.tsx).
cd "$(dirname "$0")/.." && cp scripts/TopBar.modelcap.fixed.tsx src/components/ide/TopBar.tsx && echo "model-cap fix re-applied"
