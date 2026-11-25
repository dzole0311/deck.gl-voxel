/** Maximum screen-center distance priority assigned to visible chunks */
export const MAX_VISIBLE_READ_PRIORITY = 100;

/** Added to preloads so every queued visible chunk has a lower priority number */
export const BACKGROUND_PRIORITY = MAX_VISIBLE_READ_PRIORITY + 1;
