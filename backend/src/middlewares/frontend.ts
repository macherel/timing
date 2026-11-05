import express, { Express, Request, Response, NextFunction } from 'express';
import path from 'path';

// Frontend build output; the relative path is the same from src/middlewares and dist/middlewares
const FRONTEND_DIST_PATH = path.join(import.meta.dirname, '../../../frontend/dist');

/**
 * Serves the built frontend (production mode). In dev mode the frontend is served by Vite instead.
 */
export function setupFrontendMiddleware(app: Express): void {
    // Static assets (JS, CSS, images)
    app.use(express.static(FRONTEND_DIST_PATH));

    // SPA fallback: every non-API route returns index.html
    app.get(/(.*)/, (req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith('/api')) {
            return next(); // Let unknown API routes reach the standard 404 handler
        }

        res.sendFile(path.join(FRONTEND_DIST_PATH, 'index.html'), (err) => {
            if (err) {
                res.status(404).send(
                    'Dev mode detected: The frontend must be run via Vite (npm run dev at root) rather than the Node server.'
                );
            }
        });
    });
}
