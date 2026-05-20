import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Salekh Ventures";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#000000",
          color: "#ffffff",
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          position: "relative",
        }}
      >
        <div
          style={{
            fontSize: 460,
            fontWeight: 700,
            letterSpacing: -28,
            lineHeight: 1,
          }}
        >
          SV
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: 64,
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          Salekh Ventures
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 56,
            right: 64,
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          Software studio
        </div>
      </div>
    ),
    { ...size }
  );
}
