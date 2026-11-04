'use strict';
/**
 * tests/helpers/appStack.js
 *
 * Helper utilities for inspecting the Express middleware and configuration stack.
 *
 * Exports:
 *   - stripComments(source): Strips line (//) and block (/* * /) comments using a state
 *     machine that preserves strings, template literals, and regex literals intact.
 *   - checkAppStack(source): Pure function that analyzes the un-commented app.js source
 *     and returns an array of { id, message } for any missing or misordered statements.
 */

/**
 * Strips JavaScript single-line and multi-line comments while preserving:
 * - Single-quoted strings ('...')
 * - Double-quoted strings ("...")
 * - Template literals (`...`)
 * - Regex literals (/.../)
 * - Line numbers and whitespace offsets
 *
 * @param {string} source
 * @returns {string} Source code with comments replaced by equivalent whitespace
 */
function stripComments(source) {
  let result = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    // 1. Strings: '...' or "..."
    if (ch === "'" || ch === '"') {
      const quote = ch;
      result += ch;
      i++;
      while (i < n) {
        const c = source[i];
        result += c;
        if (c === '\\') {
          if (i + 1 < n) {
            i++;
            result += source[i];
          }
        } else if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 2. Template literals: `...`
    if (ch === '`') {
      result += ch;
      i++;
      let depth = 0;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          result += c;
          if (i + 1 < n) {
            i++;
            result += source[i];
          }
          i++;
          continue;
        }
        if (c === '`' && depth === 0) {
          result += c;
          i++;
          break;
        }
        if (c === '$' && i + 1 < n && source[i + 1] === '{') {
          result += '${';
          i += 2;
          depth++;
          continue;
        }
        if (c === '}' && depth > 0) {
          result += '}';
          i++;
          depth--;
          continue;
        }
        result += c;
        i++;
      }
      continue;
    }

    // 3. Single-line comment: // ...
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n' && source[i] !== '\r') {
        result += ' ';
        i++;
      }
      continue;
    }

    // 4. Multi-line comment: /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      result += '  ';
      while (i < n) {
        if (source[i] === '*' && i + 1 < n && source[i + 1] === '/') {
          result += '  ';
          i += 2;
          break;
        }
        result += source[i] === '\n' ? '\n' : (source[i] === '\r' ? '\r' : ' ');
        i++;
      }
      continue;
    }

    // 5. Regex literal: /.../
    if (ch === '/') {
      let prevIdx = result.length - 1;
      while (prevIdx >= 0 && /\s/.test(result[prevIdx])) {
        prevIdx--;
      }
      const prevChar = prevIdx >= 0 ? result[prevIdx] : '';
      const isRegex = prevIdx === -1 || /[(=,;:!&|?+*\-%^~<>{\[]/.test(prevChar) ||
        /(?:return|typeof|delete|void|throw|case|in|instanceof|yield|await)$/.test(result.slice(0, prevIdx + 1));

      if (isRegex) {
        result += ch;
        i++;
        let inCharClass = false;
        while (i < n) {
          const c = source[i];
          result += c;
          if (c === '\\') {
            if (i + 1 < n) {
              i++;
              result += source[i];
            }
          } else if (c === '[') {
            inCharClass = true;
          } else if (c === ']' && inCharClass) {
            inCharClass = false;
          } else if (c === '/' && !inCharClass) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

const REQUIRED_RULES = [
  {
    id: 'trust-proxy',
    pattern: /app\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/,
    message: "app.set('trust proxy', 1) is required",
  },
  {
    id: 'view-engine',
    pattern: /app\.set\(\s*['"]view engine['"]\s*,\s*['"]ejs['"]\s*\)/,
    message: "app.set('view engine', 'ejs') is required",
  },
  {
    id: 'views-dir',
    pattern: /app\.set\(\s*['"]views['"]\s*,/,
    message: "app.set('views', ...) is required",
  },
  {
    id: 'express-urlencoded',
    pattern: /app\.use\(\s*express\.urlencoded\s*\(/,
    message: "app.use(express.urlencoded(...)) is required",
  },
  {
    id: 'express-json',
    pattern: /app\.use\(\s*express\.json\s*\(/,
    message: "app.use(express.json(...)) is required",
  },
  {
    id: 'method-override',
    pattern: /app\.use\(\s*methodOverride\s*\(/,
    message: "app.use(methodOverride(...)) is required",
  },
  {
    id: 'compression',
    pattern: /app\.use\(\s*compression\s*\(\s*\)\s*\)/,
    message: "app.use(compression()) is required",
  },
  {
    id: 'general-limiter-def',
    pattern: /(?:const|let|var)\s+generalLimiter\s*=\s*rateLimit\(\{[\s\S]*?max:\s*300[\s\S]*?skip:[\s\S]*?\/api\/cron[\s\S]*?\/auth\/heartbeat[\s\S]*?\}\)/,
    message: "generalLimiter definition with max 300 and skip for /api/cron and /auth/heartbeat is required",
  },
  {
    id: 'general-limiter-mount',
    pattern: /app\.use\(\s*generalLimiter\s*\)/,
    message: "app.use(generalLimiter) is required",
  },
  {
    id: 'login-limiter-def',
    pattern: /(?:const|let|var)\s+loginLimiter\s*=\s*rateLimit\(\{[\s\S]*?(?:windowMs:\s*15\s*\*\s*60\s*\*\s*1000[\s\S]*?max:\s*20|max:\s*20[\s\S]*?windowMs:\s*15\s*\*\s*60\s*\*\s*1000)[\s\S]*?\}\)/,
    message: "loginLimiter definition with windowMs 15m and max 20 is required",
  },
  {
    id: 'login-limiter-mount',
    pattern: /app\.use\(\s*['"]\/auth\/login['"]\s*,\s*loginLimiter\s*\)/,
    message: "app.use('/auth/login', loginLimiter) is required",
  },
  {
    id: 'csp',
    pattern: /app\.use\(\s*helmet\(\{[\s\S]*?contentSecurityPolicy|\bcreateCspMiddleware\s*\(/,
    message: "CSP middleware (helmet contentSecurityPolicy or createCspMiddleware) is required",
  },
  {
    id: 'csp-report-mount',
    pattern: /app\.use\(\s*['"]\/csp-report['"]\s*,/,
    message: "app.use('/csp-report', ...) is required",
  },
  {
    id: 'cron-mount',
    pattern: /app\.use\(\s*['"]\/api\/cron['"]\s*,/,
    message: "app.use('/api/cron', ...) is required",
  },
  {
    id: 'session',
    pattern: /app\.use\(\s*session\s*\(/,
    message: "app.use(session(...)) is required",
  },
  {
    id: 'csrf',
    pattern: /app\.use\(\s*csrfProtection\s*\)/,
    message: "app.use(csrfProtection) is required",
  },
];

/**
 * Checks an Express app.js source string against required middleware and configuration rules.
 *
 * @param {string} source - Raw JavaScript source of app.js
 * @returns {Array<{ id: string, message: string }>} Missing or misordered issues (empty if OK)
 */
function checkAppStack(source) {
  const stripped = stripComments(source);
  const issues = [];

  for (const rule of REQUIRED_RULES) {
    if (!rule.pattern.test(stripped)) {
      issues.push({ id: rule.id, message: rule.message });
    }
  }

  // Ordering checks: anchored to real mount statements
  const cronMatch = stripped.match(/app\.use\(\s*['"]\/api\/cron['"]\s*,/);
  const sessionMatch = stripped.match(/app\.use\(\s*session\s*\(/);
  const cspReportMatch = stripped.match(/app\.use\(\s*['"]\/csp-report['"]\s*,/);

  if (cronMatch && sessionMatch) {
    if (cronMatch.index > sessionMatch.index) {
      issues.push({
        id: 'cron-before-session',
        message: "/api/cron mount must appear before session middleware",
      });
    }
  }

  if (cspReportMatch && sessionMatch) {
    if (cspReportMatch.index > sessionMatch.index) {
      issues.push({
        id: 'csp-report-before-session',
        message: "/csp-report mount must appear before session middleware",
      });
    }
  }

  return issues;
}

module.exports = {
  stripComments,
  checkAppStack,
  REQUIRED_RULES,
};
