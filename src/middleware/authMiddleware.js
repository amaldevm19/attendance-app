
import jwt from 'jsonwebtoken';

// Load environment variables (create a .env file)
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';

const authMiddleware = (req, res, next) => {
  // Get token from header
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach user data to request
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};

export default authMiddleware;