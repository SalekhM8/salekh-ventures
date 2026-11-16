import { SignIn } from "./SignIn";

export const metadata = { title: "Sign in | The White House", robots: { index: false, follow: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ link?: string }> }) {
  const { link } = await searchParams;
  return <SignIn expired={link === "expired"} />;
}
