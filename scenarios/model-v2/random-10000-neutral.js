"use strict";

const { runRandom10000TrendModelV2 } = require("./scenario-core");

runRandom10000TrendModelV2({
  regime: "neutral",
  title: "Model V2: Neutral 10000 Trades",
  priceSeed: "v2-neutral-price",
  tradeSeed: "v2-neutral-trades",
});
