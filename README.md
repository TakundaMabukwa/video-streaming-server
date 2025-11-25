# Video Feed Server

A minimal Express.js server with organized structure and best practices.

## Structure

```
src/
├── config/          # Configuration files
├── controllers/     # Request handlers
├── helpers/         # Utility functions
├── routes/          # Route definitions
└── server.js        # Main server file
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start development server:
   ```bash
   npm run dev
   ```

3. Start production server:
   ```bash
   npm start
   ```

## API Endpoints

### Basic Endpoints
- `GET /api/health` - Health check
- `GET /api/videos` - Get all videos
- `GET /api/videos/:id` - Get video by ID

### Live Streaming Endpoints
- `POST /api/stream/customers` - Get customer tree
- `POST /api/stream/devices` - Get devices list
- `POST /api/stream/live` - Get live stream URL
- `POST /api/stream/control` - Control stream (switch bitstream)

Server runs on http://localhost:3000