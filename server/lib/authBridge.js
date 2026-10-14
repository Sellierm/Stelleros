let cached;
const load = () => (cached ??= import("./auth.mjs"));

async function getSession(req) {
  const { auth, fromNodeHeaders } = await load();
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

const authHandler = async (req, res, next) => {
  try {
    const { handler } = await load();
    return handler(req, res);
  } catch (err) {
    next(err);
  }
};

module.exports = { getSession, authHandler };
