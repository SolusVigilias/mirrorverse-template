const fs = require("fs");
const path = require("path");

const provPath = path.join("provenance", "provenance-with-sha.json");
const outPath  = path.join("out", "latent.json");

const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));

const totalFrames = prov.frames || 120;

const frames = [];

for (let i = 0; i < totalFrames; i++) {

  // fake latent spiral
  const t = i / totalFrames * Math.PI * 4;

  const z1 = Math.cos(t) * (0.2 + i / totalFrames);
  const z2 = Math.sin(t) * (0.2 + i / totalFrames);

  frames.push({
    i,

    z: [z1, z2],

    defects:
      Math.floor(
        4 + 3 * Math.sin(t * 1.7)
      ),

    energy:
      0.5 + 0.5 * Math.sin(t * 0.7),

    hammingFromPrev:
      i === 0
        ? null
        : Math.floor(
            10 + 20 * Math.abs(Math.sin(t))
          ),

    png:
      `${String(i).padStart(4, "0")}.png`
  });
}

const latent = {
  schema: "latent-mvp-v0",
  frames
};

fs.writeFileSync(
  outPath,
  JSON.stringify(latent, null, 2)
);

console.log("wrote", outPath);