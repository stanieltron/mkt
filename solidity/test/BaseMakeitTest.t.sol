pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Makeit} from "../src/Makeit.sol";
import {MakeitProxy} from "../src/MakeitProxy.sol";
import {MockPriceOracle} from "./helpers/MockPriceOracle.sol";
import {MockSwapAdapter} from "./helpers/MockSwapAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {TestWETH} from "./helpers/TestWETH.sol";

abstract contract BaseMakeitTest is Test {
    uint256 internal constant DEFAULT_PRICE_E18 = 3_000e18;
    uint256 internal constant DEFAULT_POOL_WETH = 100e18;
    uint256 internal constant DEFAULT_POOL_USDC = 500_000e6;
    uint256 internal constant DEFAULT_ADAPTER_WETH = 100e18;
    uint256 internal constant DEFAULT_ADAPTER_USDC = 500_000e6;
    uint32 internal constant DEFAULT_TP_PPM = 1_000_000;

    address internal trader = address(0xA11CE);
    address internal traderTwo = address(0xB0B);
    address internal stranger = address(0xCAFE);
    address internal liquidator = address(0xD00D);
    address internal treasury = address(0xEEEE);

    TestERC20 internal usdc;
    TestWETH internal weth;
    MockPriceOracle internal oracle;
    MockSwapAdapter internal adapter;
    Makeit internal implementation;
    Makeit internal makeit;

    function setUp() public virtual {
        vm.deal(address(this), 10_000_000e18);
        usdc = new TestERC20("Test USD Coin", "tUSDC", 6);
        weth = new TestWETH();
        oracle = new MockPriceOracle(DEFAULT_PRICE_E18);
        adapter = new MockSwapAdapter(address(usdc), address(weth), address(oracle));
        implementation = new Makeit();
        makeit = Makeit(
            payable(
                address(
                    new MakeitProxy(
                        address(implementation),
                        abi.encodeCall(Makeit.initialize, (address(usdc), address(weth), address(this)))
                    )
                )
            )
        );

        makeit.setOracle(address(oracle));
        makeit.setExternalDex(address(adapter));

        _mintUsdc(trader, 1_000_000e6);
        _mintUsdc(traderTwo, 1_000_000e6);
        _approveUser(trader);
        _approveUser(traderTwo);
    }

    function _approveUser(address user) internal {
        vm.prank(user);
        usdc.approve(address(makeit), type(uint256).max);
    }

    function _mintUsdc(address to, uint256 amount) internal {
        usdc.mint(to, amount);
    }

    function _mintWeth(address to, uint256 amount) internal {
        weth.mint{value: amount}(to, amount);
    }

    function _seedMakeit() internal {
        _fundMakeit(DEFAULT_POOL_WETH, DEFAULT_POOL_USDC);
    }

    function _seedAdapter() internal {
        _fundAdapter(DEFAULT_ADAPTER_WETH, DEFAULT_ADAPTER_USDC);
    }

    function _seedAll() internal {
        _seedMakeit();
        _seedAdapter();
    }

    function _fundMakeit(uint256 wethAmount, uint256 usdcAmount) internal {
        if (wethAmount > 0) {
            _mintWeth(address(this), wethAmount);
            weth.approve(address(makeit), type(uint256).max);
        makeit.configureLpProvision(address(this), true, type(uint256).max);
        makeit.deposit(wethAmount, address(this));
        }

        if (usdcAmount > 0) {
            _mintUsdc(address(this), usdcAmount);
            usdc.approve(address(makeit), type(uint256).max);
        }
    }

    function _fundAdapter(uint256 wethAmount, uint256 usdcAmount) internal {
        if (wethAmount > 0) {
            _mintWeth(address(adapter), wethAmount);
        }

        if (usdcAmount > 0) {
            _mintUsdc(address(adapter), usdcAmount);
        }
    }

    function _setPrice(uint256 newPriceE18) internal {
        oracle.setPriceE18(newPriceE18);
    }

    function _expectedPrice() internal view returns (uint256) {
        return oracle.priceE18();
    }

    function _netMargin(uint256 grossMargin, uint256 totalFeePpm) internal pure returns (uint256) {
        return grossMargin - ((grossMargin * totalFeePpm) / 1_000_000);
    }

    function _calculateFee(uint256 margin, uint256 leverage, uint256 totalFeePpm) internal pure returns (uint256) {
        return (margin * leverage * totalFeePpm) / 1_000_000;
    }

    function _openLongTradeAs(address user, uint32 profitTargetPpm, uint32 tradeLeverage, uint96 marginUSDC) internal returns (uint256 tradeId) {
        uint256 expectedPriceE18 = _expectedPrice();
        vm.prank(user);
        tradeId = makeit.openLongTrade(expectedPriceE18, 100, profitTargetPpm, tradeLeverage, marginUSDC);
    }

    function _openShortTradeAs(
        address user,
        uint32 profitTargetPpm,
        uint32 tradeLeverage,
        uint96 marginUSDC
    ) internal returns (uint256 tradeId) {
        uint256 expectedPriceE18 = _expectedPrice();
        vm.prank(user);
        tradeId = makeit.openShortTrade(expectedPriceE18, 100, profitTargetPpm, tradeLeverage, marginUSDC);
    }
}
