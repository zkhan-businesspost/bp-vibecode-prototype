import { isOriginAllowed } from '../../config/security';
import { createLogger } from '../../logger';

const logger = createLogger('WebSocketSecurity');

export function validateWebSocketOrigin(request: Request, env: Env): boolean {
    const origin = request.headers.get('Origin');
    
    if (!origin) {
        logger.warn('WebSocket connection attempt without Origin header');
        return false;
    }
    
    if (!isOriginAllowed(env, origin)) {
        logger.warn('WebSocket connection rejected from unauthorized origin', { origin });
        return false;
    }
    
    return true;
}

export function getWebSocketSecurityHeaders(): Record<string, string> {
    return {
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'X-XSS-Protection': '1; mode=block'
    };
}
