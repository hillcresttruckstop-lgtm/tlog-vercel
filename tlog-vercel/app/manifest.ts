import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hillcrest Truck Stop — Live Operations",
    short_name: "Hillcrest",
    description: "Live pump & register feed",
    start_url: "/",
    display: "standalone",
    background_color: "#0A1220",
    theme_color: "#0A1220",
    icons: [
      {
        src: "/mascot-128.png",
        sizes: "128x128",
        type: "image/png",
      },
      {
        src: "/mascot.png",
        sizes: "600x585",
        type: "image/png",
      },
    ],
  };
}
