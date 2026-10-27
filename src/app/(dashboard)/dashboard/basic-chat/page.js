import { redirect } from "next/navigation";

// The old hidden page is now the Playground; keep bookmarks working.
export default function BasicChatRedirect() {
  redirect("/dashboard/playground");
}
