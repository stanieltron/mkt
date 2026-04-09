pragma solidity ^0.8.20;

import {OwnedV3} from "./OwnedV3.sol";
import {IPriceOracleV3} from "./interfaces/IPriceOracleV3.sol";
import {IERC20MetadataMinimal} from "./interfaces/IERC20MetadataMinimal.sol";
import {IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3PoolMinimal.sol";
import {FullMath} from "./libraries/FullMath.sol";

contract UniswapV3PoolOracleV3 is OwnedV3, IPriceOracleV3 {
    error InvalidTokenPair();
    error InvalidTokenDecimals();
    error InvalidSqrtPrice();

    uint256 private constant Q192 = 2 ** 192;
    uint256 private constant Q128 = 2 ** 128;

    address public immutable USDC;
    address public immutable WETH;
    address public pool;

    bool public wethIsToken0;
    uint256 public immutable wethUnit;
    uint256 public immutable usdcToE18Scale;

    event PoolSet(address indexed previousPool, address indexed newPool);

    constructor(address initialPool, address usdc, address weth, address initialOwner) OwnedV3(initialOwner) {
        if (initialPool == address(0) || usdc == address(0) || weth == address(0)) revert InvalidAddress();

        uint8 usdcDecimals = IERC20MetadataMinimal(usdc).decimals();
        uint8 wethDecimals = IERC20MetadataMinimal(weth).decimals();
        if (usdcDecimals > 18 || wethDecimals > 77) revert InvalidTokenDecimals();

        USDC = usdc;
        WETH = weth;

        wethUnit = 10 ** uint256(wethDecimals);
        usdcToE18Scale = 10 ** uint256(18 - usdcDecimals);

        _setPool(initialPool);
    }

    function setPool(address newPool) external onlyOwner {
        _setPool(newPool);
    }

    function getPriceE18() external view returns (uint256 priceE18) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3PoolMinimal(pool).slot0();
        if (sqrtPriceX96 == 0) revert InvalidSqrtPrice();

        uint256 usdcForOneWethRaw = _quoteUsdcFromWethRaw(sqrtPriceX96, wethUnit);
        priceE18 = usdcForOneWethRaw * usdcToE18Scale;
        if (priceE18 == 0) revert InvalidSqrtPrice();
    }

    function _quoteUsdcFromWethRaw(uint160 sqrtPriceX96, uint256 wethAmountRaw) internal view returns (uint256 usdcAmountRaw) {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
            if (wethIsToken0) {
                return FullMath.mulDiv(ratioX192, wethAmountRaw, Q192);
            }
            return FullMath.mulDiv(Q192, wethAmountRaw, ratioX192);
        }

        uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        if (wethIsToken0) {
            return FullMath.mulDiv(ratioX128, wethAmountRaw, Q128);
        }
        return FullMath.mulDiv(Q128, wethAmountRaw, ratioX128);
    }

    function _setPool(address newPool) internal {
        if (newPool == address(0)) revert InvalidAddress();

        address token0 = IUniswapV3PoolMinimal(newPool).token0();
        address token1 = IUniswapV3PoolMinimal(newPool).token1();

        bool token0IsWeth = token0 == WETH && token1 == USDC;
        bool token1IsWeth = token1 == WETH && token0 == USDC;
        if (!token0IsWeth && !token1IsWeth) revert InvalidTokenPair();

        address previousPool = pool;
        pool = newPool;
        wethIsToken0 = token0IsWeth;

        emit PoolSet(previousPool, newPool);
    }
}

