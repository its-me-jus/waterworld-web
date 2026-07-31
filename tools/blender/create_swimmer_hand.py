"""
Build an owned mid-poly right DIVE GLOVE for WaterWorld.

Designed as padded neoprene (not bare skin): continuous finger tubes (no bead
joints), thick palm + grip pad, flared wrist that mates with the in-game gauntlet.

Coordinate contract after export (matches src/swimmer.ts):
  - Wrist at the origin
  - Fingers along -Y
  - Palm faces +Z
  - Thumb toward -X

Run: npm run hands
"""

from __future__ import annotations

import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "hands"
BLEND_DIR = ROOT / "assets" / "blender"
OUT_GLB = OUT_DIR / "right.glb"
OUT_BLEND = BLEND_DIR / "swimmer_hand.blend"
PREVIEW = ROOT / "shots" / "hand-blender.png"

# Dive-glove proportions — slightly puffy vs bare hand
PALM_LEN = 0.095
PALM_W = 0.078
PALM_D = 0.032

# Index → pinky: one continuous tube each (avoids bead knuckles)
# Mild curl — too much and FPS view only sees fingertip blobs
FINGERS = [
    {"x": -0.029, "fan": -0.07, "len": 0.084, "r0": 0.0112, "r1": 0.0072},
    {"x": -0.010, "fan": -0.02, "len": 0.092, "r0": 0.0116, "r1": 0.0075},
    {"x": 0.010, "fan": 0.04, "len": 0.088, "r0": 0.0110, "r1": 0.0072},
    {"x": 0.028, "fan": 0.10, "len": 0.072, "r0": 0.0098, "r1": 0.0064},
]
FINGER_CURL = 0.16

THUMB = {
    "root": Vector((-0.032, -0.036, 0.012)),
    "yaw": 0.85,
    "roll": -0.55,
    "len": 0.066,
    "r0": 0.0128,
    "r1": 0.0082,
    "curl": 0.18,
}

VOXEL = 0.00115
TARGET_TRIS = 8000


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)


def glove_material() -> bpy.types.Material:
    mat = bpy.data.materials.new(name="DiveGlove")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    # Match in-game glove ~0x12161c
    bsdf.inputs["Base Color"].default_value = (0.07, 0.085, 0.11, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.62
    bsdf.inputs["Metallic"].default_value = 0.06
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.4
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def apply_tr(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def cube(name: str, loc: Vector, scale: Vector, rot: Euler | None = None) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    if rot:
        obj.rotation_euler = rot
    apply_tr(obj)
    return obj


def sphere(name: str, loc: Vector, radius: float, seg: int = 14) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=seg, ring_count=max(7, seg // 2), radius=radius, location=loc
    )
    obj = bpy.context.active_object
    obj.name = name
    apply_tr(obj)
    return obj


def capsule(
    name: str,
    start: Vector,
    direction: Vector,
    length: float,
    r0: float,
    r1: float,
    segments: int = 14,
) -> bpy.types.Object:
    """Tapered capsule from start along direction; overlaps start for welding."""
    direction = direction.normalized()
    # Pull start back so it embeds into palm/knuckle
    embed = r0 * 0.55
    start = start - direction * embed
    length = length + embed
    mid = start + direction * (length * 0.5)
    quat = direction.to_track_quat("Z", "Y")
    bpy.ops.mesh.primitive_cone_add(
        vertices=segments,
        radius1=r0,
        radius2=r1,
        depth=length,
        end_fill_type="NGON",
        location=mid,
    )
    cone = bpy.context.active_object
    cone.name = name + "_cone"
    cone.rotation_mode = "QUATERNION"
    cone.rotation_quaternion = quat
    apply_tr(cone)

    tip = start + direction * length
    tip_sph = sphere(name + "_tip", tip, r1 * 0.95, segments)
    # Base ball to round the embed
    base_sph = sphere(name + "_base", start + direction * (r0 * 0.2), r0 * 0.95, segments)

    bpy.ops.object.select_all(action="DESELECT")
    for o in (cone, tip_sph, base_sph):
        o.select_set(True)
    bpy.context.view_layer.objects.active = cone
    bpy.ops.object.join()
    cone.name = name
    return cone


def join_all(objs: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def build_parts() -> list[bpy.types.Object]:
    parts: list[bpy.types.Object] = []

    # —— palm body ————————————————————————————————————————
    # Extends toward wrist so remesh doesn't leave a thin neck
    parts.append(
        cube(
            "Palm",
            Vector((0.0, -PALM_LEN * 0.42, 0.004)),
            Vector((PALM_W * 0.48, PALM_LEN * 0.52, PALM_D * 0.48)),
        )
    )
    parts.append(
        cube(
            "Grip",
            Vector((0.0, -PALM_LEN * 0.48, 0.018)),
            Vector((PALM_W * 0.40, PALM_LEN * 0.40, 0.009)),
        )
    )
    parts.append(
        cube(
            "KnuckleRidge",
            Vector((0.0, -PALM_LEN + 0.010, -0.004)),
            Vector((PALM_W * 0.44, 0.014, 0.012)),
        )
    )

    # —— wrist flare (mates with in-game gauntlet) ——————————
    bpy.ops.mesh.primitive_cone_add(
        vertices=16,
        radius1=0.032,
        radius2=0.024,
        depth=0.055,
        location=Vector((0.0, -0.012, 0.0)),
    )
    wrist = bpy.context.active_object
    wrist.name = "WristFlare"
    wrist.rotation_euler = (math.pi / 2, 0, 0)
    apply_tr(wrist)
    parts.append(wrist)
    parts.append(sphere("WristBall", Vector((0.0, 0.0, 0.0)), 0.028, 16))
    # Extra weld between wrist and palm
    parts.append(sphere("WristWeld", Vector((0.0, -0.028, 0.002)), 0.026, 14))

    # Thenar / hypothenar pads
    parts.append(
        cube(
            "Thenar",
            Vector((-0.022, -0.040, 0.012)),
            Vector((0.018, 0.026, 0.013)),
            Euler((0.12, 0.2, -0.45)),
        )
    )
    parts.append(
        cube(
            "Hypo",
            Vector((0.024, -0.050, 0.008)),
            Vector((0.013, 0.022, 0.011)),
            Euler((0.08, -0.1, 0.18)),
        )
    )

    # —— fingers: one continuous padded tube each ——————————
    for i, f in enumerate(FINGERS):
        knuckle = Vector((f["x"], -PALM_LEN + 0.006, 0.006))
        # Metacarpal stub — bridges palm into finger so remesh doesn't leave gaps
        meta_mid = Vector((f["x"] * 0.55, -PALM_LEN * 0.70, 0.006))
        parts.append(sphere(f"Meta_{i}", meta_mid, f["r0"] * 1.15, 12))
        parts.append(sphere(f"Knuckle_{i}", knuckle, f["r0"] * 1.12, 12))

        q = Quaternion((0, 0, 1), f["fan"]) @ Quaternion((1, 0, 0), -FINGER_CURL)
        direction = q @ Vector((0, -1, 0))
        parts.append(capsule(f"F{i}", knuckle, direction, f["len"], f["r0"], f["r1"]))

    # —— thumb ————————————————————————————————————————————
    tq = (
        Quaternion((0, 1, 0), THUMB["yaw"])
        @ Quaternion((0, 0, 1), THUMB["roll"])
        @ Quaternion((1, 0, 0), -THUMB["curl"])
    )
    tdir = tq @ Vector((0, -1, 0))
    parts.append(sphere("ThumbBridge", Vector((-0.018, -0.022, 0.008)), 0.014, 12))
    parts.append(sphere("ThumbKnuckle", THUMB["root"], THUMB["r0"] * 1.1, 12))
    parts.append(
        capsule("Thumb", THUMB["root"], tdir, THUMB["len"], THUMB["r0"], THUMB["r1"])
    )

    return parts


def remesh_organic(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    remesh = obj.modifiers.new(name="Remesh", type="REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = VOXEL
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    # Keep largest island only
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

    candidates = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    keep = max(candidates, key=lambda o: len(o.data.vertices))
    for o in candidates:
        if o != keep:
            bpy.data.objects.remove(o, do_unlink=True)

    bpy.ops.object.select_all(action="DESELECT")
    keep.select_set(True)
    bpy.context.view_layer.objects.active = keep
    keep.name = "RightHand"

    # Smooth enough to erase voxel stairs, not so much fingers fuse
    smooth = keep.modifiers.new(name="Smooth", type="SMOOTH")
    smooth.factor = 0.4
    smooth.iterations = 12
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    # Force poly budget (calc_loop_triangles can be stale right after remesh)
    faces = len(keep.data.polygons)
    est_tris = faces * 2
    if est_tris > TARGET_TRIS:
        dec = keep.modifiers.new(name="Decimate", type="DECIMATE")
        dec.ratio = max(0.2, TARGET_TRIS / est_tris)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    bpy.ops.object.shade_smooth()
    return keep


def snap_wrist(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    max_y = max(v.co.y for v in bm.verts)
    for v in bm.verts:
        v.co.y -= max_y
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def smart_uv(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception:
        pass
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )


def render_preview(obj: bpy.types.Object, path: Path) -> None:
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    target = Vector((0.0, -0.01, -0.09))
    cam.location = (0.18, -0.24, 0.04)
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 50

    for name, loc, energy in (
        ("Key", (0.4, -0.5, 0.35), 500),
        ("Fill", (-0.35, -0.2, 0.2), 200),
        ("Rim", (0.0, 0.35, -0.1), 160),
    ):
        light = bpy.data.lights.new(name, "AREA")
        light.energy = energy
        light.size = 0.7
        lo = bpy.data.objects.new(name, light)
        lo.location = loc
        bpy.context.collection.objects.link(lo)

    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 800
    scene.render.filepath = str(path)
    scene.render.image_settings.file_format = "PNG"
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.14, 0.15, 0.17, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print(f"[hand] preview {path}")


def main() -> None:
    clear_scene()
    parts = build_parts()
    hand = join_all(parts, "RightHand")
    hand = remesh_organic(hand)

    mat = glove_material()
    hand.data.materials.clear()
    hand.data.materials.append(mat)
    for poly in hand.data.polygons:
        poly.material_index = 0

    snap_wrist(hand)
    smart_uv(hand)

    # Counteract glTF Y-up remap (x,y,z)→(x,z,-y)
    hand.location = (0, 0, 0)
    hand.rotation_euler = (math.pi / 2, 0, 0)
    bpy.context.view_layer.objects.active = hand
    hand.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    hand.name = "RightHand"
    hand.data.name = "RightHand"

    hand.data.calc_loop_triangles()
    print(f"[hand] triangle count: {len(hand.data.loop_triangles)}")
    print(f"[hand] vertices: {len(hand.data.vertices)}")
    bm = bmesh.new()
    bm.from_mesh(hand.data)
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    print(f"[hand] blender bounds X {min(xs):.4f}..{max(xs):.4f}")
    print(f"[hand] blender bounds Y {min(ys):.4f}..{max(ys):.4f}")
    print(f"[hand] blender bounds Z {min(zs):.4f}..{max(zs):.4f}")
    # Finger length check
    print(f"[hand] length along -Z: {abs(min(zs)):.4f} m")
    bm.free()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    BLEND_DIR.mkdir(parents=True, exist_ok=True)
    export_glb(hand, OUT_GLB)
    render_preview(hand, PREVIEW)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND))
    print(f"[hand] wrote {OUT_GLB}")
    print(f"[hand] wrote {OUT_BLEND}")


if __name__ == "__main__":
    main()
