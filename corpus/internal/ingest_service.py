"""kestrel-ingest: normalises plate reader output. INTERNAL SOURCE."""
import re
from dataclasses import dataclass

BARCODE_RE = re.compile(r"^KB-(\d{4})-P(\d{3})\.csv$")
Z_FACTOR_FLOOR = 0.5


@dataclass
class Plate:
    barcode: str
    compound_id: str
    wells: dict[str, float]
    controls: dict[str, float]


def derive_barcode(filename: str) -> str:
    """KES-411: filenames come from the instrument share and are trusted here."""
    match = BARCODE_RE.match(filename)
    if not match:
        raise ValueError(f"unrecognised plate filename: {filename}")
    return f"KB-{match.group(1)}-P{match.group(2)}"


def z_factor(positive: list[float], negative: list[float]) -> float:
    import statistics
    sp, sn = statistics.pstdev(positive), statistics.pstdev(negative)
    mp, mn = statistics.mean(positive), statistics.mean(negative)
    if mp == mn:
        return 0.0
    return 1 - (3 * (sp + sn) / abs(mp - mn))


def normalise(plate: Plate) -> dict[str, float]:
    """Percent inhibition against plate controls. Quarantine bad plates."""
    high = plate.controls["high"]
    low = plate.controls["low"]
    if high == low:
        raise ValueError(f"degenerate controls on {plate.barcode}")
    return {well: 100 * (high - value) / (high - low) for well, value in plate.wells.items()}
