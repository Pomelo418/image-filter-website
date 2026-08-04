# Image Filters

Upload a photo, apply a filter, download the result. Runs entirely in your browser using Canvas 2D — no account, no API key, no upload to any server, no cost, ever.

## Filters

Vintage Sepia, Classic B&W, Noir, Vivid, Golden Warm, Cool Blue, Faded Matte, Cinematic, Neon Cyberpunk, Anime Sky Glow, Comic Pop Art, Pencil Sketch, Pixel Art, Claymation.

These are color-grading / compositing effects computed on-device (saturation, contrast, color balance, posterize, edge detection, blur/bloom). They restyle color and texture, not shape — they can't redraw a photo into a chibi character or fully repaint it in another artist's hand, since that requires a paid generative AI model (see note below).

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. (You can also just open `public/index.html` directly in a browser — no server required.)

## Why not real AI style transfer (chibi, Makoto Shinkai, etc.)?

We initially tried wiring this up to free AI image-editing APIs (Pollinations Kontext, Google Gemini image, Hugging Face). All of them turned out to gate actual image generation behind payment or a tiny trial credit (Hugging Face: $0.10/month, good for a handful of images). If you want genuine AI restyling later, this app can be pointed at any image-editing API you're willing to pay a small per-image fee for — the cost is typically 1–4 cents per image.
