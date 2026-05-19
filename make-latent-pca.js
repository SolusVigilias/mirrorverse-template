const fs = require("fs");
const path = require("path");

const { PNG } = require("pngjs");
const { PCA }= require("ml-pca");

const FRAME_DIR = path.join("out", "frames");
const OUT_JSON  = path.join("out", "latent.json");

const SIZE = 32;

function readPNG(file){

  return new Promise((resolve,reject)=>{

    fs.createReadStream(file)
      .pipe(new PNG())
      .on("parsed", function(){

        resolve(this);
      })
      .on("error", reject);
  });
}

function detectDefects(vec, size){

  let count = 0;
  let energy = 0;

  for(let y=1;y<size-1;y++){

    for(let x=1;x<size-1;x++){

      const i = y * size + x;

      const dx =
        vec[i+1] - vec[i-1];

      const dy =
        vec[i+size] - vec[i-size];

      const g =
        Math.sqrt(dx*dx + dy*dy);

      energy += g;

      if(g > 0.22){
        count++;
      }
    }
  }

  return {
    defects: count,
    energy
  };
}

function downsampleGray(png){

  const vec = [];

  for(let y=0;y<SIZE;y++){

    for(let x=0;x<SIZE;x++){

      const sx = Math.floor(x / SIZE * png.width);
      const sy = Math.floor(y / SIZE * png.height);

      const idx = (sy * png.width + sx) * 4;

      const r = png.data[idx];
      const g = png.data[idx+1];
      const b = png.data[idx+2];

      const gray = (r+g+b)/3 / 255;

      vec.push(gray);
    }
  }

  return vec;
}

async function main(){

  const files = fs.readdirSync(FRAME_DIR)
    .filter(f => f.endsWith(".png"))
    .sort();

  console.log("frames:", files.length);

  const X = [];
  const metrics = [];
  for(const f of files){

    const png = await readPNG(
      path.join(FRAME_DIR, f)
    );

    const feat = downsampleGray(png);

    const diag =
      detectDefects(feat, SIZE);

    X.push(feat);

    metrics.push(diag);
  }

  console.log("running PCA...");

  const pca = new PCA(X);

  const projected = pca.predict(X).to2DArray();

  const frames = projected.map((z,i)=>({

    i,

    z: [
      z[0],
      z[1]
    ],

    defects: metrics[i].defects,
    
    energy: metrics[i].energy,

    hammingFromPrev:
      i===0
      ? null
      : Math.floor(
          Math.abs(z[0]-projected[i-1][0])*10
        ),

    png: files[i]
  }));

  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({
      schema:"latent-pca-v0",
      frames
    }, null, 2)
  );

  console.log("wrote", OUT_JSON);
}

main();