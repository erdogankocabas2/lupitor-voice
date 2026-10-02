import { NextResponse, type NextRequest } from "next/server";

const EXPECTED_USER = process.env.CONSOLE_USER || "lupitor";
const EXPECTED_PASS = process.env.CONSOLE_PASSWORD || "lupitor-voice";

export function middleware(req: NextRequest) {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const colonIndex = decoded.indexOf(":");
      const user = colonIndex !== -1 ? decoded.slice(0, colonIndex) : "";
      const pass = colonIndex !== -1 ? decoded.slice(colonIndex + 1) : "";
      if (user === EXPECTED_USER && pass === EXPECTED_PASS) {
        return NextResponse.next();
      }
    } catch {
      // invalid base64 encoding
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Lupitor Voice Platform", charset="UTF-8"',
    },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

