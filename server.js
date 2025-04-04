const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const socketio = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const port = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Enhanced in-memory storage with timestamps
let products = [];
let orders = [];
const connectionLogs = [];
const requestLogs = [];
let serverStartTime = new Date();

// Middleware with enhanced logging
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const logEntry = {
    timestamp: new Date(),
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };
  requestLogs.push(logEntry);
  if (NODE_ENV === 'development') {
    console.log(`[${logEntry.timestamp.toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// Enhanced Socket.io connection with heartbeat monitoring
io.on('connection', (socket) => {
  const clientInfo = {
    id: socket.id,
    ip: socket.handshake.address,
    connectedAt: new Date()
  };
  
  connectionLogs.push({
    event: 'connect',
    ...clientInfo
  });
  console.log(`Client connected: ${clientInfo.id}`);

  // Send current products to newly connected client
  socket.emit('init_products', products);

  // Heartbeat monitoring
  let missedPings = 0;
  const heartbeatInterval = setInterval(() => {
    if (missedPings > 2) {
      socket.disconnect(true);
    }
    missedPings++;
    socket.emit('ping');
  }, 10000);

  socket.on('pong', () => {
    missedPings = 0;
  });

  socket.on('disconnect', (reason) => {
    clearInterval(heartbeatInterval);
    connectionLogs.push({
      event: 'disconnect',
      ...clientInfo,
      disconnectedAt: new Date(),
      reason
    });
    console.log(`Client disconnected: ${clientInfo.id} (${reason})`);
  });

  socket.on('error', (err) => {
    console.error(`Socket error (${clientInfo.id}):`, err);
  });
});

// System monitoring endpoint
app.get('/system-status', (req, res) => {
  const status = {
    server: {
      uptime: process.uptime(),
      startTime: serverStartTime,
      nodeVersion: process.version,
      environment: NODE_ENV
    },
    system: {
      load: os.loadavg(),
      memory: {
        total: os.totalmem(),
        free: os.freemem()
      }
    },
    connections: {
      active: io.engine.clientsCount,
      total: connectionLogs.length
    },
    data: {
      products: products.length,
      orders: orders.length
    }
  };
  res.json(status);
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    server: {
      uptime: process.uptime(),
      status: 'running'
    },
    stats: {
      products: products.length,
      orders: orders.length,
      connections: io.engine.clientsCount,
      requests: requestLogs.length
    },
    lastProduct: products[products.length - 1] || null,
    recentConnections: connectionLogs.slice(-5),
    recentRequests: requestLogs.slice(-5).map(r => ({
      time: r.timestamp.toISOString(),
      method: r.method,
      path: r.path
    }))
  });
});

// Product endpoints with enhanced validation
app.post('/product', (req, res) => {
  try {
    const requiredFields = ['id', 'name', 'price', 'units', 'taken', 'payable'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    const product = {
      ...req.body,
      addedAt: new Date()
    };

    products.push(product);
    io.emit('new_product', product);
    
    res.status(201).json({
      success: true,
      product
    });

  } catch (error) {
    console.error('Product addition error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Bulk product operations
app.post('/products/reset', (req, res) => {
  products = [];
  io.emit('products_reset');
  res.json({
    success: true,
    message: 'All products cleared'
  });
});

// Enhanced product listing with filtering
app.get('/product', (req, res) => {
  const { name, minPrice, maxPrice } = req.query;
  let filteredProducts = [...products];

  if (name) {
    filteredProducts = filteredProducts.filter(p => 
      p.name.toLowerCase().includes(name.toLowerCase())
    );
  }

  if (minPrice) {
    filteredProducts = filteredProducts.filter(p => p.price >= parseFloat(minPrice));
  }

  if (maxPrice) {
    filteredProducts = filteredProducts.filter(p => p.price <= parseFloat(maxPrice));
  }

  res.json({
    success: true,
    count: filteredProducts.length,
    data: filteredProducts
  });
});

// Existing product endpoints remain the same
app.get('/product/:id', (req, res) => {
  const product = products.find(p => p.id == req.params.id);
  
  if (!product) {
    return res.status(404).json({
      success: false,
      error: 'Product not found'
    });
  }
  
  res.json({
    success: true,
    data: product
  });
});

app.delete('/product/:id', (req, res) => {
  const index = products.findIndex(p => p.id == req.params.id);
  
  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: 'Product not found'
    });
  }
  
  const [deletedProduct] = products.splice(index, 1);
  io.emit('product_deleted', deletedProduct.id);
  
  res.json({
    success: true,
    data: deletedProduct
  });
});

// Enhanced order processing
app.post('/checkout', (req, res) => {
  try {
    if (!req.body.items || !Array.isArray(req.body.items) || req.body.items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Order must contain at least one item'
      });
    }

    const order = {
      ...req.body,
      id: `order_${Date.now()}`,
      createdAt: new Date(),
      status: 'pending'
    };

    orders.push(order);
    io.emit('new_order', order);
    
    res.status(201).json({
      success: true,
      order
    });

  } catch (error) {
    console.error('Order processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Server startup
server.listen(port, () => {
  console.log(`Server running in ${NODE_ENV} mode on port ${port}`);
  console.log(`WebSocket available at ws://localhost:${port}`);
  console.log(`Debug endpoint: http://localhost:${port}/debug`);
  console.log(`System status: http://localhost:${port}/system-status`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
