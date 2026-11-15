import { RetainedPage } from "~/components/workbench/retained-routes";
import { connection } from "next/server";
export default async function Page() {
  // The formula tab must expose its disabled pre-hydration controls in HTML.
  await connection();
  return <RetainedPage route="/scan" />;
}
