const authMiddleware = require("./auth");
// mock调底层的redis依赖
jest.mock("../db/redis", () => ({
  get: jest.fn(),
}));
const redisClient = require("../db/redis");

describe("Auth Middleware 鉴权测试", () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      signedCookies: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });
  it("如果没有userId cookie，应该返回401请先登录", async () => {
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].message).toBe("请先登录");
    expect(next).not.toHaveBeenCalled();
  });

  it("如果Redis中Session过期，应该返回401", async () => {
    req.signedCookies = { userId: "123", sessionId: "old-session" };
    redisClient.get.mockResolvedValue(null); // 模拟redis查不到数据

    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].message).toBe("登录已过期，请重新登录");
  });

  it("鉴权成功，将userId挂到req上，并调用next", async () => {
    req.signedCookies = { userId: "123", sessionId: "valid-session" };
    redisClient.get.mockResolvedValue("valid-session");

    await authMiddleware(req, res, next);
    expect(req.userId).toBe("123");
    expect(next).toHaveBeenCalled();
  });
});
