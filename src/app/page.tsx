import { redirect } from "next/navigation";

/**
 * The root is not a screen. Middleware has already decided whether this request
 * has a session, so by the time we get here the only useful thing to do is send
 * the user to the inbox (or, if unauthenticated, let middleware bounce them to
 * /login on the way).
 */
export default function RootPage() {
  redirect("/leads");
}
