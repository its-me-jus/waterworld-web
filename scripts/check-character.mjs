import {chromium} from 'playwright-core'
import {mkdirSync,writeFileSync} from 'node:fs'
const base=process.env.SHOT_BASE??'http://127.0.0.1:5183'
const out='review/character'
mkdirSync(out,{recursive:true})
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']})
try{
 const page=await browser.newPage({viewport:{width:1000,height:900}})
 const errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
 await page.goto(`${base}/tools/character-studio.html`)
 await page.waitForFunction(()=>window.studio?.swimmer.rig.userData.handSource === 'blender')
 await page.waitForTimeout(1600)
 for(const [mode,phase] of [['walk',0],['crawl',.1],['crawl',.7],['breast',.35]]){
  await page.evaluate(([m,p])=>studio.pose(m,p),[mode,phase])
  await page.screenshot({path:`${out}/${mode}-${phase}.png`})
 }
 await page.evaluate(()=>{studio.pose('walk',0);studio.first(true)})
 await page.screenshot({path:`${out}/lookdown.png`})
 const report=await page.evaluate(async()=>{
  const THREE=await import('/node_modules/three/build/three.module.js')
  const {scene,swimmer}=studio
  studio.pose('walk',0)
  studio.pose('crawl',0)
  const swimLean=scene.getObjectByName('Body').rotation.x
  if(swimLean>-.85)throw Error('Walk-to-swim posture did not recover')
  let vertices=0,triangles=0,skinned=0,maxWeightError=0,maxWristError=0
  scene.traverse(mesh=>{if(!mesh.isMesh)return;vertices+=mesh.geometry.attributes.position.count;triangles+=(mesh.geometry.index?.count??mesh.geometry.attributes.position.count)/3;if(mesh.isSkinnedMesh){skinned++;const weights=mesh.geometry.attributes.skinWeight;for(let i=0;i<weights.count;i++)maxWeightError=Math.max(maxWeightError,Math.abs(weights.getX(i)+weights.getY(i)+weights.getZ(i)-1))}})
  const point=new THREE.Vector3(),world=new THREE.Vector3(),wrist=new THREE.Vector3()
  for(const mode of ['walk','crawl','breast'])for(let step=0;step<=24;step++){
   studio.pose(mode,(step%24)/24)
   scene.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;mesh.skeleton.update();const pos=mesh.geometry.attributes.position;const last=mesh.skeleton.bones[2];last.getWorldPosition(wrist);for(let i=0;i<pos.count;i++){point.fromBufferAttribute(pos,i);mesh.applyBoneTransform(i,point);if(!Number.isFinite(point.lengthSq()))throw Error('Non-finite skin');if(i>=pos.count-33){world.copy(point).applyMatrix4(mesh.matrixWorld);maxWristError=Math.max(maxWristError,world.distanceTo(wrist))}}})
  }
  studio.pose('walk',0)
  scene.updateMatrixWorld(true)
  const soles=[]
  scene.traverse(mesh=>{if(mesh.name!=='ContinuousLeg')return;mesh.skeleton.bones[2].getWorldPosition(point);soles.push(point.y-.05-(-1.62+.08*point.x+.04*point.z))})
  if(soles.some(clearance=>clearance < -.006))throw Error('Foot penetrated slope: '+soles)
  if(skinned!==4||maxWeightError>1e-6||maxWristError>.05)throw Error(JSON.stringify({skinned,maxWeightError,maxWristError}))
  return {vertices,triangles,skinned,maxWeightError,maxWristError,poses:75,swimLean,soleClearance:soles}
 })
 await page.setViewportSize({width:1280,height:720})
 await page.goto(`${base}/?x=775&z=-532&yaw=-1.02&pitch=-1.45`)
 await page.waitForFunction(()=>window.ww?.scene.getObjectByName('Swimmer')?.userData.handSource === 'blender')
 await page.waitForTimeout(2200)
 await page.screenshot({path:`${out}/beach-first-person.png`})
 writeFileSync(`${out}/checks.json`,JSON.stringify({report,errors},null,2))
 console.log(JSON.stringify({report,errors},null,2))
 if(errors.length)throw Error(errors.join('\n'))
}finally{await browser.close()}
