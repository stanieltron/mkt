pragma solidity ^0.8.20;

interface ISwapRouterCanonical {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

interface IERC20Compat {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);
}

contract SwapRouterCompat {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    ISwapRouterCanonical public immutable router;
    mapping(address => bool) private _approved;

    constructor(address routerAddress) {
        router = ISwapRouterCanonical(routerAddress);
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        _pullAndApprove(params.tokenIn, params.amountIn);

        amountOut = router.exactInputSingle{value: msg.value}(
            ISwapRouterCanonical.ExactInputSingleParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                fee: params.fee,
                recipient: params.recipient,
                deadline: block.timestamp,
                amountIn: params.amountIn,
                amountOutMinimum: params.amountOutMinimum,
                sqrtPriceLimitX96: params.sqrtPriceLimitX96
            })
        );
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn) {
        _pullAndApprove(params.tokenIn, params.amountInMaximum);

        amountIn = router.exactOutputSingle{value: msg.value}(
            ISwapRouterCanonical.ExactOutputSingleParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                fee: params.fee,
                recipient: params.recipient,
                deadline: block.timestamp,
                amountOut: params.amountOut,
                amountInMaximum: params.amountInMaximum,
                sqrtPriceLimitX96: params.sqrtPriceLimitX96
            })
        );

        if (amountIn < params.amountInMaximum) {
            uint256 refund = params.amountInMaximum - amountIn;
            require(IERC20Compat(params.tokenIn).transfer(msg.sender, refund), "REFUND");
        }
    }

    function _pullAndApprove(address token, uint256 amount) private {
        require(IERC20Compat(token).transferFrom(msg.sender, address(this), amount), "PULL");

        if (!_approved[token]) {
            _approved[token] = true;
            require(IERC20Compat(token).approve(address(router), type(uint256).max), "APPROVE");
        }
    }
}
