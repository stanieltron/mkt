pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {SafeTransferLib} from "./SafeTransferLib.sol";
import {IPriceOracleV3} from "./interfaces/IPriceOracleV3.sol";
import {ISwapAdapterV3} from "./interfaces/ISwapAdapterV3.sol";

interface IWETH9 {
    function withdraw(uint256) external;
}

contract Makeit is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ERC20Upgradeable {
    using SafeTransferLib for address;

    enum Side {
        LONG,
        SHORT
    }

    enum Status {
        OPEN,
        CLOSED_TP,
        CLOSED_SL,
        CLOSED_EARLY
    }

    struct Trade {
        address trader;
        Side side;
        Status status;
        uint40 openedAt;
        uint32 profitTargetPpm;
        uint32 leverage;
        uint96 marginUSDC;
        uint128 notionalUSDC;
        uint256 entryPriceE18;
        uint256 tpPriceE18;
        uint256 slPriceE18;
    }

    error Reentrancy();
    error InvalidAddress();
    error InvalidRebalanceAmount(uint256 amount);
    error InsufficientFreeUsdc(uint256 requestedUSDC, uint256 availableUSDC);
    error EffectiveMarginTooSmall(uint96 grossMarginUSDC);
    error InvalidFundingAmount(uint256 amount);
    error InvalidPrice();
    error InvalidExpectedPrice();
    error InvalidTolerance();
    error InvalidProfitTarget(uint32 profitTargetPpm, uint32 tradeLeverage);
    error InvalidTradeLeverage(uint32 tradeLeverage, uint32 maxLeverage);
    error InvalidMaxLeverage(uint32 maxLeverage);
    error PriceOutOfTolerance(uint256 oraclePriceE18, uint256 expectedPriceE18, uint256 toleranceBps);
    error InsufficientEthCoverage(uint256 requestedOpenNotionalUSDC, uint256 availableNotionalUSDC);
    error NoLongNotionalToOffsetShort(uint256 requestedShortNotionalUSDC, uint256 availableLongNotionalUSDC);
    error TradingFrozen();
    error InvalidWithdrawAmount(uint256 requestedAmount);
    error ETHTransferFailed();
    error NotTrader();
    error TradeNotOpen();
    error MustUseLiquidation(uint256 tradeId, uint256 closePriceE18, uint256 tpPriceE18, uint256 slPriceE18);
    error NoTpOrSlHit(uint256 tradeId, uint256 closePriceE18, uint256 tpPriceE18, uint256 slPriceE18);
    error OracleNotSet();
    error ExternalDexNotSet();
    error SwapDidNotRaiseEnoughUSDC(uint256 neededUSDC, uint256 raisedUSDC);
    error ReservedMarginExceedsPoolUSDC(uint256 reservedMarginUSDC, uint256 poolUSDC);
    error InvalidFeeSplit(uint32 liquidityProvisionFeePpm, uint32 protocolFeePpm);
    error InvalidRecipient();
    error LpNotWhitelisted(address account);
    error LpProvisionQuotaExceeded(address account, uint256 requestedAssets, uint256 remainingAssets);
    error VaultInsufficientLiquidity(uint256 requestedAssets, uint256 availableAssets);
    error ZeroShares();
    error ZeroAssets();

    uint256 private constant PRICE_E18 = 1e18;
    uint256 private constant USDC_TO_E18 = 1e12;

    address public USDC;
    address public WETH;

    IPriceOracleV3 public priceOracle;
    ISwapAdapterV3 public externalDex;

    uint32 public maxLeverage;
    uint32 public liquidityProvisionFeePpm;
    uint32 public protocolFeePpm;
    bool public tradingIsFrozen;

    uint256 public openLongNotionalUSDC;
    uint256 public openShortNotionalUSDC;
    uint256 public reservedMarginUSDC;
    uint256 public protocolFeeAccruedUSDC;
    uint256 public nextTradeId;
    address public protocolFeeRecipient;

    mapping(address => bool) public lpProvisionWhitelist;
    mapping(address => uint256) public lpProvisionMaxAssets;
    mapping(address => uint256) public lpProvisionUsedAssets;

    mapping(uint256 => Trade) public trades;

    uint256 private _reentrancyLock;

    event OracleSet(address indexed previousOracle, address indexed newOracle);
    event ExternalDexSet(address indexed previousExternalDex, address indexed newExternalDex);
    event MaxLeverageUpdated(uint32 previousMaxLeverage, uint32 newMaxLeverage);
    event FeeSplitUpdated(
        uint32 previousLiquidityProvisionFeePpm,
        uint32 previousProtocolFeePpm,
        uint32 newLiquidityProvisionFeePpm,
        uint32 newProtocolFeePpm
    );
    event TradingFreezeSet(bool frozen);
    event ProtocolFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event OwnerWithdrawETH(address indexed to, uint256 ethAmount18);

    event PoolFundedETH(address indexed from, uint256 wethAmount18);
    event PoolFundedUSDC(address indexed from, uint256 usdcAmount6);
    event ProtocolFeesSwept(address indexed caller, address indexed recipient, uint256 usdcAmount6);
    event LpProvisionConfigured(address indexed account, bool whitelisted, uint256 maxAssets);
    event VaultBootstrap(address indexed receiver, uint256 assets, uint256 shares);

    event TradeOpened(
        uint256 indexed tradeId,
        address indexed trader,
        Side side,
        uint32 profitTargetPpm,
        uint256 entryPriceE18,
        uint256 tpPriceE18,
        uint256 slPriceE18,
        uint32 leverage,
        uint256 marginUSDC,
        uint256 notionalUSDC
    );

    event TradeClosed(
        uint256 indexed tradeId,
        address indexed trader,
        Side side,
        Status status,
        uint256 closePriceE18,
        uint32 profitTargetPpm,
        uint256 payoutUSDC,
        int256 pnlUSDC,
        uint256 soldWETHForProfit,
        uint256 boughtWETHOnSL
    );

    event ManualRebalance(uint256 usdcSpent6, uint256 wethBought18);

    modifier nonReentrant() {
        if (_reentrancyLock != 1) revert Reentrancy();
        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    constructor() {
        _disableInitializers();
    }

    receive() external payable {}

    function initialize(address usdc, address weth, address initialOwner) external initializer {
        if (usdc == address(0) || weth == address(0) || initialOwner == address(0)) revert InvalidAddress();

        __ERC20_init("Makeit LP Share", "mLP");
        __Ownable_init(initialOwner);
        __Ownable2Step_init();

        USDC = usdc;
        WETH = weth;
        maxLeverage = 300;
        liquidityProvisionFeePpm = 70;
        protocolFeePpm = 30;
        protocolFeeRecipient = initialOwner;
        nextTradeId = 1;
        _reentrancyLock = 1;
    }

    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidAddress();
        address previous = address(priceOracle);
        priceOracle = IPriceOracleV3(newOracle);
        emit OracleSet(previous, newOracle);
    }

    function setExternalDex(address newExternalDex) external onlyOwner {
        if (newExternalDex == address(0)) revert InvalidAddress();
        address previous = address(externalDex);
        externalDex = ISwapAdapterV3(newExternalDex);

        USDC.forceApprove(newExternalDex, 0);
        USDC.forceApprove(newExternalDex, type(uint256).max);
        WETH.forceApprove(newExternalDex, 0);
        WETH.forceApprove(newExternalDex, type(uint256).max);

        emit ExternalDexSet(previous, newExternalDex);
    }





    function setFeeSplitPpm(uint32 newLiquidityProvisionFeePpm, uint32 newProtocolFeePpm) external onlyOwner {
        uint32 totalFeePpm = newLiquidityProvisionFeePpm + newProtocolFeePpm;
        if (totalFeePpm > 1_000_000) revert InvalidFeeSplit(newLiquidityProvisionFeePpm, newProtocolFeePpm);

        uint32 previousLiquidityProvisionFeePpm = liquidityProvisionFeePpm;
        uint32 previousProtocolFeePpm = protocolFeePpm;

        liquidityProvisionFeePpm = newLiquidityProvisionFeePpm;
        protocolFeePpm = newProtocolFeePpm;

        emit FeeSplitUpdated(
            previousLiquidityProvisionFeePpm,
            previousProtocolFeePpm,
            newLiquidityProvisionFeePpm,
            newProtocolFeePpm
        );
    }



    function setMaxLeverage(uint32 newMaxLeverage) external onlyOwner {
        if (newMaxLeverage <= 1) revert InvalidMaxLeverage(newMaxLeverage);
        uint32 previousMaxLeverage = maxLeverage;
        maxLeverage = newMaxLeverage;
        emit MaxLeverageUpdated(previousMaxLeverage, newMaxLeverage);
    }

    function setTradingFrozen(bool frozen) external onlyOwner {
        tradingIsFrozen = frozen;
        emit TradingFreezeSet(frozen);
    }

    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert InvalidRecipient();
        address previousRecipient = protocolFeeRecipient;
        protocolFeeRecipient = newRecipient;
        emit ProtocolFeeRecipientUpdated(previousRecipient, newRecipient);
    }

    function configureLpProvision(address account, bool whitelisted, uint256 maxAssets) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        lpProvisionWhitelist[account] = whitelisted;
        lpProvisionMaxAssets[account] = maxAssets;
        emit LpProvisionConfigured(account, whitelisted, maxAssets);
    }

    function asset() external view returns (address) {
        return WETH;
    }

    function totalAssets() public view returns (uint256) {
        uint256 wethAssets = _balanceOf(WETH);
        uint256 freeUsdc = _freeUsdcBalance();
        uint256 priceE18 = _tryGetPriceE18();
        if (priceE18 == 0 || freeUsdc == 0) return wethAssets;
        return wethAssets + _wethFromUsdcFloor(freeUsdc, priceE18);
    }

    function availableWithdrawalAssets() public view returns (uint256) {
        uint256 priceE18 = _tryGetPriceE18();
        if (priceE18 == 0) return 0;

        uint256 currentWeth = _balanceOf(WETH);
        uint256 netExposure = _netLongNotional(openLongNotionalUSDC, openShortNotionalUSDC);
        uint256 reservedBackingWeth = _wethFromUsdcCeil(netExposure, priceE18);
        return currentWeth > reservedBackingWeth ? currentWeth - reservedBackingWeth : 0;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 assetsTotal = totalAssets();
        if (supply == 0 || assetsTotal == 0) return assets;
        return (assets * supply) / assetsTotal;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 assetsTotal = totalAssets();
        if (supply == 0 || assetsTotal == 0) return shares;
        return (shares * assetsTotal) / supply;
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 assetsTotal = totalAssets();
        if (supply == 0 || assetsTotal == 0) return shares;
        return (shares * assetsTotal + supply - 1) / supply;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 assetsTotal = totalAssets();
        if (supply == 0 || assetsTotal == 0) return assets;
        return (assets * supply + assetsTotal - 1) / assetsTotal;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address account) public view returns (uint256) {
        if (!lpProvisionWhitelist[account]) return 0;
        uint256 quota = lpProvisionMaxAssets[account];
        uint256 used = lpProvisionUsedAssets[account];
        return quota > used ? quota - used : 0;
    }

    function maxMint(address account) public view returns (uint256) {
        return convertToShares(maxDeposit(account));
    }

    function maxWithdraw(address owner_) public view returns (uint256) {
        uint256 ownedAssets = convertToAssets(balanceOf(owner_));
        uint256 availableAssets = availableWithdrawalAssets();
        return ownedAssets < availableAssets ? ownedAssets : availableAssets;
    }

    function maxRedeem(address owner_) public view returns (uint256) {
        uint256 withdrawableAssets = maxWithdraw(owner_);
        uint256 shares = previewWithdraw(withdrawableAssets);
        uint256 ownedShares = balanceOf(owner_);
        return shares < ownedShares ? shares : ownedShares;
    }

    function bootstrapVault(address receiver) external onlyOwner nonReentrant returns (uint256 shares) {
        if (receiver == address(0)) revert InvalidRecipient();
        if (totalSupply() != 0) revert ZeroShares();
        uint256 assets = totalAssets();
        if (assets == 0) revert ZeroAssets();
        shares = assets;
        _mint(receiver, shares);
        emit VaultBootstrap(receiver, assets, shares);
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAssets();
        if (receiver == address(0)) revert InvalidRecipient();
        _consumeProvisionQuota(msg.sender, assets);
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroShares();
        WETH.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert InvalidRecipient();
        assets = previewMint(shares);
        _consumeProvisionQuota(msg.sender, assets);
        WETH.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAssets();
        if (receiver == address(0)) revert InvalidRecipient();
        if (assets > maxWithdraw(owner_)) revert VaultInsufficientLiquidity(assets, maxWithdraw(owner_));
        shares = previewWithdraw(assets);
        _spendAllowanceIfNeeded(owner_, shares);
        _burn(owner_, shares);
        _releaseProvisionQuota(owner_, assets);
        WETH.safeTransfer(receiver, assets);
    }

    function redeem(uint256 shares, address receiver, address owner_) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert InvalidRecipient();
        assets = previewRedeem(shares);
        if (assets > maxWithdraw(owner_)) revert VaultInsufficientLiquidity(assets, maxWithdraw(owner_));
        _spendAllowanceIfNeeded(owner_, shares);
        _burn(owner_, shares);
        _releaseProvisionQuota(owner_, assets);
        WETH.safeTransfer(receiver, assets);
    }

    function sweepProtocolFees() external nonReentrant returns (uint256 amount) {
        amount = _withdrawableProtocolFees();
        if (amount == 0) return 0;
        address recipient = protocolFeeRecipient;
        if (recipient == address(0)) revert InvalidRecipient();
        protocolFeeAccruedUSDC -= amount;
        USDC.safeTransfer(recipient, amount);
        emit ProtocolFeesSwept(msg.sender, recipient, amount);
    }

    function ownerWithdrawETH(uint256 wethAmount18, address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (wethAmount18 == 0 || wethAmount18 > _balanceOf(WETH)) revert InvalidWithdrawAmount(wethAmount18);

        IWETH9(WETH).withdraw(wethAmount18);
        (bool success, ) = to.call{value: wethAmount18}("");
        if (!success) revert ETHTransferFailed();

        emit OwnerWithdrawETH(to, wethAmount18);
    }

    function getOraclePriceE18() external view returns (uint256) {
        return _getPriceE18();
    }

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }


    function openLongTrade(
        uint256 expectedPriceE18,
        uint256 toleranceBps,
        uint32 profitTargetPpm,
        uint32 tradeLeverage,
        uint96 tradeMarginUSDC
    ) external nonReentrant returns (uint256 tradeId) {
        return _openTrade(Side.LONG, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage, tradeMarginUSDC);
    }

    function openShortTrade(
        uint256 expectedPriceE18,
        uint256 toleranceBps,
        uint32 profitTargetPpm,
        uint32 tradeLeverage,
        uint96 tradeMarginUSDC
    ) external nonReentrant returns (uint256 tradeId) {
        return _openTrade(Side.SHORT, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage, tradeMarginUSDC);
    }

    function close(uint256 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.OPEN) revert TradeNotOpen();
        if (msg.sender != t.trader) revert NotTrader();

        uint256 closePriceE18 = _getPriceE18();
        (bool hitTP, bool hitSL) = _hitLevels(t, closePriceE18);
        if (hitTP || hitSL) revert MustUseLiquidation(tradeId, closePriceE18, t.tpPriceE18, t.slPriceE18);

        int256 pnlUSDC = _realizedPnlUSDC(t, closePriceE18);

        _settleTrade(tradeId, t, Status.CLOSED_EARLY, closePriceE18, pnlUSDC);
    }

    function liquidateTrade(uint256 tradeId) public nonReentrant {
        Trade storage t = trades[tradeId];
        if (t.status != Status.OPEN) revert TradeNotOpen();

        _closeTrade(tradeId, t);
    }

    function rebalanceUsdcToEth(uint256 usdcAmount6) external onlyOwner nonReentrant {
        if (usdcAmount6 == 0) revert InvalidRebalanceAmount(usdcAmount6);
        uint256 freeUsdc = _freeUsdcBalance();
        if (usdcAmount6 > freeUsdc) revert InsufficientFreeUsdc(usdcAmount6, freeUsdc);

        (, uint256 wethBought18) = _buyWETHWithExactUSDC(usdcAmount6);
        emit ManualRebalance(usdcAmount6, wethBought18);
    }

    struct OpenTradeVars {
        uint256 priceE18;
        uint96 effectiveMarginUSDC;
        uint256 notionalUSDC;
        uint256 tpPriceE18;
        uint256 slPriceE18;
        uint256 protocolFeeAmount;
    }

    function _openTrade(
        Side side,
        uint256 expectedPriceE18,
        uint256 toleranceBps,
        uint32 profitTargetPpm,
        uint32 tradeLeverage,
        uint96 tradeMarginUSDC
    ) internal returns (uint256 tradeId) {
        if (tradingIsFrozen) revert TradingFrozen();
        if (expectedPriceE18 == 0) revert InvalidExpectedPrice();
        if (toleranceBps > 10_000) revert InvalidTolerance();
        if (tradeLeverage <= 1 || tradeLeverage > maxLeverage) revert InvalidTradeLeverage(tradeLeverage, maxLeverage);

        OpenTradeVars memory v;
        v.priceE18 = _getPriceE18();
        _checkTolerance(v.priceE18, expectedPriceE18, toleranceBps);

        v.effectiveMarginUSDC = _tradeMarginUSDC(tradeMarginUSDC, tradeLeverage);
        v.notionalUSDC = uint256(v.effectiveMarginUSDC) * uint256(tradeLeverage);
        if (v.notionalUSDC > type(uint128).max) revert InvalidTradeLeverage(tradeLeverage, maxLeverage);

        (v.tpPriceE18, v.slPriceE18) = side == Side.LONG
            ? _levelsLong(v.priceE18, profitTargetPpm, tradeLeverage)
            : _levelsShort(v.priceE18, profitTargetPpm, tradeLeverage);

        if (side == Side.LONG) {
            uint256 requestedOpenNotionalUSDC = _netLongNotional(openLongNotionalUSDC + v.notionalUSDC, openShortNotionalUSDC);
            uint256 availableNotionalUSDC = _ethValueUSDC(v.priceE18);
            if (requestedOpenNotionalUSDC > availableNotionalUSDC) {
                revert InsufficientEthCoverage(requestedOpenNotionalUSDC, availableNotionalUSDC);
            }
        } else {
            uint256 requestedShortNotionalUSDC = openShortNotionalUSDC + v.notionalUSDC;
            if (requestedShortNotionalUSDC > openLongNotionalUSDC) {
                revert NoLongNotionalToOffsetShort(requestedShortNotionalUSDC, openLongNotionalUSDC);
            }
        }

        USDC.safeTransferFrom(msg.sender, address(this), tradeMarginUSDC);

        v.protocolFeeAmount = _protocolFeeAmountUSDC(tradeMarginUSDC, tradeLeverage);
        if (v.protocolFeeAmount > 0) {
            protocolFeeAccruedUSDC += v.protocolFeeAmount;
        }

        tradeId = nextTradeId++;
        trades[tradeId] = Trade({
            trader: msg.sender,
            side: side,
            status: Status.OPEN,
            openedAt: uint40(block.timestamp),
            profitTargetPpm: profitTargetPpm,
            leverage: tradeLeverage,
            marginUSDC: v.effectiveMarginUSDC,
            notionalUSDC: uint128(v.notionalUSDC),
            entryPriceE18: v.priceE18,
            tpPriceE18: v.tpPriceE18,
            slPriceE18: v.slPriceE18
        });

        if (side == Side.LONG) {
            openLongNotionalUSDC += v.notionalUSDC;
        } else {
            openShortNotionalUSDC += v.notionalUSDC;
        }
        reservedMarginUSDC += v.effectiveMarginUSDC;

        emit TradeOpened(
            tradeId,
            msg.sender,
            side,
            profitTargetPpm,
            v.priceE18,
            v.tpPriceE18,
            v.slPriceE18,
            tradeLeverage,
            v.effectiveMarginUSDC,
            v.notionalUSDC
        );
    }

    function _closeTrade(uint256 tradeId, Trade storage t) internal {
        uint256 closePriceE18 = _getPriceE18();
        (bool hitTP, bool hitSL) = _hitLevels(t, closePriceE18);
        if (!hitTP && !hitSL) revert NoTpOrSlHit(tradeId, closePriceE18, t.tpPriceE18, t.slPriceE18);

        Status closeStatus = hitTP ? Status.CLOSED_TP : Status.CLOSED_SL;
        int256 pnlUSDC;
        if (hitTP) {
            pnlUSDC = int256((uint256(t.marginUSDC) * uint256(t.profitTargetPpm)) / 1_000_000);
        } else {
            pnlUSDC = -int256(uint256(t.marginUSDC));
        }
        _settleTrade(tradeId, t, closeStatus, closePriceE18, pnlUSDC);
    }

    function _settleTrade(
        uint256 tradeId,
        Trade storage t,
        Status closeStatus,
        uint256 closePriceE18,
        int256 pnlUSDC
    ) internal {
        int256 payoutSigned = int256(uint256(t.marginUSDC)) + pnlUSDC;
        uint256 payoutUSDC = payoutSigned <= 0 ? 0 : uint256(payoutSigned);
        uint256 releasedMarginUSDC = uint256(t.marginUSDC);
        uint256 availableUsdc = _freeUsdcBalance() + releasedMarginUSDC;
        uint256 soldWETHForProfit = 0;
        uint256 boughtWETHOnSL = 0;

        if (availableUsdc < payoutUSDC) {
            uint256 neededUSDC = payoutUSDC - availableUsdc;
            uint256 usdcOut;
            (soldWETHForProfit, usdcOut) = _sellWETHForExactUSDC(neededUSDC);
            if (usdcOut < neededUSDC) revert SwapDidNotRaiseEnoughUSDC(neededUSDC, usdcOut);
        }

        reservedMarginUSDC -= releasedMarginUSDC;
        if (payoutUSDC < uint256(t.marginUSDC) && t.side == Side.LONG) {
            uint256 lostUSDC = uint256(t.marginUSDC) - payoutUSDC;
            (, boughtWETHOnSL) = _buyWETHWithExactUSDC(lostUSDC);
        }

        if (payoutUSDC > 0) {
            uint256 poolUSDC = _balanceOf(USDC);
            if (poolUSDC < reservedMarginUSDC + payoutUSDC) {
                revert ReservedMarginExceedsPoolUSDC(reservedMarginUSDC, poolUSDC);
            }
            USDC.safeTransfer(t.trader, payoutUSDC);
        }

        if (t.side == Side.LONG) {
            openLongNotionalUSDC -= t.notionalUSDC;
        } else {
            openShortNotionalUSDC -= t.notionalUSDC;
        }
        t.status = closeStatus;

        emit TradeClosed(
            tradeId,
            t.trader,
            t.side,
            closeStatus,
            closePriceE18,
            t.profitTargetPpm,
            payoutUSDC,
            pnlUSDC,
            soldWETHForProfit,
            boughtWETHOnSL
        );
    }



    function _netLongNotional(uint256 longNotionalUSDC, uint256 shortNotionalUSDC) internal pure returns (uint256) {
        return longNotionalUSDC > shortNotionalUSDC ? longNotionalUSDC - shortNotionalUSDC : 0;
    }

    function _hitLevels(Trade storage t, uint256 closePriceE18) internal view returns (bool hitTP, bool hitSL) {
        if (t.side == Side.LONG) {
            hitTP = closePriceE18 >= t.tpPriceE18;
            hitSL = closePriceE18 <= t.slPriceE18;
        } else {
            hitTP = closePriceE18 <= t.tpPriceE18;
            hitSL = closePriceE18 >= t.slPriceE18;
        }
    }

    function _realizedPnlUSDC(Trade storage t, uint256 closePriceE18) internal view returns (int256 pnlUSDC) {
        int256 priceDelta;
        if (t.side == Side.LONG) {
            priceDelta = closePriceE18 >= t.entryPriceE18
                ? int256(closePriceE18 - t.entryPriceE18)
                : -int256(t.entryPriceE18 - closePriceE18);
        } else {
            priceDelta = closePriceE18 <= t.entryPriceE18
                ? int256(t.entryPriceE18 - closePriceE18)
                : -int256(closePriceE18 - t.entryPriceE18);
        }

        pnlUSDC = (int256(uint256(t.notionalUSDC)) * priceDelta) / int256(t.entryPriceE18);
    }

    function _tradeMarginUSDC(uint96 tradeMarginUSDC, uint32 tradeLeverage) internal view returns (uint96 tradeMargin) {
        uint256 feeAmount = _totalFeeAmountUSDC(tradeMarginUSDC, tradeLeverage);
        if (feeAmount >= tradeMarginUSDC) revert EffectiveMarginTooSmall(tradeMarginUSDC);
        tradeMargin = uint96(uint256(tradeMarginUSDC) - feeAmount);
    }

    function _levelsLong(
        uint256 entryPriceE18,
        uint32 profitTargetPpm,
        uint32 tradeLeverage
    ) internal view returns (uint256 tpPriceE18, uint256 slPriceE18) {
        uint256 tpMove = (entryPriceE18 * uint256(profitTargetPpm)) / (1_000_000 * uint256(tradeLeverage));
        uint256 slMove = entryPriceE18 / uint256(tradeLeverage);
        if (profitTargetPpm == 0 || tpMove == 0 || slMove == 0 || tpMove >= entryPriceE18 || slMove >= entryPriceE18) {
            revert InvalidProfitTarget(profitTargetPpm, tradeLeverage);
        }

        tpPriceE18 = entryPriceE18 + tpMove;
        slPriceE18 = entryPriceE18 - slMove;
    }

    function _levelsShort(
        uint256 entryPriceE18,
        uint32 profitTargetPpm,
        uint32 tradeLeverage
    ) internal view returns (uint256 tpPriceE18, uint256 slPriceE18) {
        uint256 tpMove = (entryPriceE18 * uint256(profitTargetPpm)) / (1_000_000 * uint256(tradeLeverage));
        uint256 slMove = entryPriceE18 / uint256(tradeLeverage);
        if (profitTargetPpm == 0 || tpMove == 0 || slMove == 0) revert InvalidProfitTarget(profitTargetPpm, tradeLeverage);

        tpPriceE18 = entryPriceE18 - tpMove;
        slPriceE18 = entryPriceE18 + slMove;
    }

    function _buyWETHWithExactUSDC(uint256 usdcIn6) internal returns (uint256 usdcSpent6, uint256 wethOut18) {
        ISwapAdapterV3 dex = externalDex;
        if (address(dex) == address(0)) revert ExternalDexNotSet();
        return dex.buyWETHWithExactUSDC(usdcIn6, address(this), address(this));
    }

    function _sellWETHForExactUSDC(uint256 usdcNeeded6) internal returns (uint256 wethSold18, uint256 usdcOut6) {
        ISwapAdapterV3 dex = externalDex;
        if (address(dex) == address(0)) revert ExternalDexNotSet();
        return dex.sellWETHForExactUSDC(usdcNeeded6, address(this), address(this));
    }

    function _getPriceE18() internal view returns (uint256 priceE18) {
        IPriceOracleV3 oracle = priceOracle;
        if (address(oracle) == address(0)) revert OracleNotSet();
        priceE18 = oracle.getPriceE18();
        if (priceE18 == 0) revert InvalidPrice();
    }

    function _checkTolerance(uint256 oraclePriceE18, uint256 expectedPriceE18, uint256 toleranceBps) internal pure {
        uint256 diff = oraclePriceE18 > expectedPriceE18
            ? oraclePriceE18 - expectedPriceE18
            : expectedPriceE18 - oraclePriceE18;
        if (diff * 10_000 > expectedPriceE18 * toleranceBps) {
            revert PriceOutOfTolerance(oraclePriceE18, expectedPriceE18, toleranceBps);
        }
    }

    function _ethValueUSDC(uint256 priceE18) internal view returns (uint256) {
        return ((_balanceOf(WETH) * priceE18) / PRICE_E18) / USDC_TO_E18;
    }

    function _wethFromUsdcFloor(uint256 usdcAmount6, uint256 priceE18) internal pure returns (uint256 wethAmount18) {
        wethAmount18 = (usdcAmount6 * USDC_TO_E18 * PRICE_E18) / priceE18;
    }

    function _wethFromUsdcCeil(uint256 usdcAmount6, uint256 priceE18) internal pure returns (uint256 wethAmount18) {
        wethAmount18 = (usdcAmount6 * USDC_TO_E18 * PRICE_E18 + priceE18 - 1) / priceE18;
    }

    function _balanceOf(address token) internal view returns (uint256 bal) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert InvalidAddress();
        bal = abi.decode(data, (uint256));
    }

    function _freeUsdcBalance() internal view returns (uint256 bal) {
        uint256 poolUSDC = _balanceOf(USDC);
        if (poolUSDC < reservedMarginUSDC) revert ReservedMarginExceedsPoolUSDC(reservedMarginUSDC, poolUSDC);
        bal = poolUSDC - reservedMarginUSDC - _withdrawableProtocolFees(poolUSDC);
    }

    function _consumeProvisionQuota(address provider, uint256 assets) internal {
        if (!lpProvisionWhitelist[provider]) revert LpNotWhitelisted(provider);
        uint256 maxAssets = lpProvisionMaxAssets[provider];
        uint256 usedAssets = lpProvisionUsedAssets[provider];
        uint256 remainingAssets = maxAssets > usedAssets ? maxAssets - usedAssets : 0;
        if (assets > remainingAssets) revert LpProvisionQuotaExceeded(provider, assets, remainingAssets);
        lpProvisionUsedAssets[provider] = usedAssets + assets;
    }

    function _releaseProvisionQuota(address provider, uint256 assets) internal {
        uint256 usedAssets = lpProvisionUsedAssets[provider];
        lpProvisionUsedAssets[provider] = assets >= usedAssets ? 0 : usedAssets - assets;
    }

    function _spendAllowanceIfNeeded(address owner_, uint256 shares) internal {
        if (msg.sender == owner_) return;
        uint256 currentAllowance = allowance(owner_, msg.sender);
        if (currentAllowance != type(uint256).max) {
            _approve(owner_, msg.sender, currentAllowance - shares);
        }
    }

    function _tryGetPriceE18() internal view returns (uint256 priceE18) {
        IPriceOracleV3 oracle = priceOracle;
        if (address(oracle) == address(0)) return 0;
        (bool ok, bytes memory data) = address(oracle).staticcall(abi.encodeWithSelector(IPriceOracleV3.getPriceE18.selector));
        if (!ok || data.length < 32) return 0;
        priceE18 = abi.decode(data, (uint256));
    }

    function _baseTotalFeePpm() internal view returns (uint32) {
        return liquidityProvisionFeePpm + protocolFeePpm;
    }

    function _totalFeeAmountUSDC(uint96 tradeMarginUSDC, uint32 tradeLeverage) internal view returns (uint256) {
        return (uint256(tradeMarginUSDC) * uint256(tradeLeverage) * uint256(_baseTotalFeePpm())) / 1_000_000;
    }

    function _protocolFeeAmountUSDC(uint96 tradeMarginUSDC, uint32 tradeLeverage) internal view returns (uint256) {
        return (uint256(tradeMarginUSDC) * uint256(tradeLeverage) * uint256(protocolFeePpm)) / 1_000_000;
    }

    function _withdrawableProtocolFees() internal view returns (uint256) {
        return _withdrawableProtocolFees(_balanceOf(USDC));
    }

    function _withdrawableProtocolFees(uint256 poolUSDC) internal view returns (uint256) {
        if (poolUSDC <= reservedMarginUSDC) return 0;
        uint256 unreservedUSDC = poolUSDC - reservedMarginUSDC;
        return protocolFeeAccruedUSDC < unreservedUSDC ? protocolFeeAccruedUSDC : unreservedUSDC;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert InvalidAddress();
    }
}
