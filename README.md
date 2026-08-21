# Clip Candy

A simple Node.js video cutter and combiner.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. Upload a single video to cut it, or select two or more videos to combine them in selection order.

Video processing is done locally by the server. Files and results are deleted automatically after one hour.

## Desktop app (auto-save beside the source video)

```bash
npm run desktop
```

In the desktop app, cut parts are automatically saved in the same folder as the video you selected.
