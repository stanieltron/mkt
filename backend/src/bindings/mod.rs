use ethers::prelude::abigen;

abigen!(Makeit, "abi/makeit.json");
abigen!(Oracle, "abi/oracle.json");
abigen!(SwapAdapter, "abi/swap_adapter.json");
abigen!(Pool, "abi/pool.json");
abigen!(Erc20, "abi/erc20.json");
