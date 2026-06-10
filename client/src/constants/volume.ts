// Single source of truth for the 250M volume figure.
//
// `VOLUME_HIGH_THRESHOLD` drives the CoinList "high volume" highlight
// (tickers at/above it render bright/white). The min-volume filter slider
// (store VOLUME_FILTER_MAX + VolumeSlider MAX_VOLUME_M) also references this
// value because today both concepts land on the same 250M. They are kept in
// one place to kill the magic number, but remain independent concepts — if
// the slider cap ever diverges from the highlight threshold, split them here.

/** High-volume highlight threshold, in raw quote-volume units. */
export const VOLUME_HIGH_THRESHOLD = 250_000_000

/** Same threshold expressed in millions (used by the slider UI). */
export const VOLUME_HIGH_THRESHOLD_M = VOLUME_HIGH_THRESHOLD / 1_000_000

/** Default min-volume filter applied on first load, in raw quote-volume units. */
export const VOLUME_FILTER_DEFAULT = 50_000_000
