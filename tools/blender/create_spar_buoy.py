"""Rebuild the crossing marker: blender --background --python tools/blender/create_spar_buoy.py"""

import math
import random
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "props" / "spar-buoy.glb"
TAU = math.tau
HEART, END, SUN, WET = (132, 102, 71), (151, 123, 88), (180, 154, 116), (67, 74, 57)
RED, ROPE, IRON, OXIDE = (166, 68, 45), (154, 133, 92), (73, 77, 71), (132, 77, 46)
placement = random.Random(529)
grain = random.Random(73)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


vertices, colors, faces, surfaces = [], [], [], []


def vertex(point, color):
    vertices.append(point)
    light = grain.uniform(0.94, 1.06)
    colors.append(tuple(min(1, max(0, v * light / 255)) for v in color) + (1,))
    return len(vertices) - 1


def face(ids, metal=False, smooth=False):
    faces.append(ids)
    surfaces.append((metal, smooth))


def skin(rings, paint, metal=False, smooth=False, closed=False, caps=True):
    """Bridge rings of corner positions along a length, then cap the two ends."""
    rows = [[vertex(p, paint(i, j, p)) for j, p in enumerate(row)] for i, row in enumerate(rings)]
    steps = list(zip(rows, rows[1:]))
    if closed:
        steps.append((rows[-1], rows[0]))
    for a, b in steps:
        for j in range(len(a)):
            k = (j + 1) % len(a)
            face((a[j], a[k], b[k], b[j]), metal, smooth)
    if not closed and caps:
        face(rows[0][::-1], metal)
        face(rows[-1], metal)


def tube(points, radii, sides, color, metal=False, closed=False, paint=None):
    points = [Vector(p) for p in points]
    rings = []
    # Transport the cross-section along the rope so its fibres never flip.
    u = None
    for i, p in enumerate(points):
        prev = points[(i - 1) % len(points)] if closed or i else p
        nxt = points[(i + 1) % len(points)] if closed or i + 1 < len(points) else p
        tangent = (nxt - prev).normalized()
        if u is None:
            u = tangent.cross(Vector((0, 1, 0)))
            if u.length < 0.05:
                u = tangent.cross(Vector((1, 0, 0)))
        u = (u - tangent * u.dot(tangent)).normalized()
        v = tangent.cross(u)
        radius = radii[i] if isinstance(radii, list) else radii
        rings.append([p + radius * (u * math.cos(TAU*j/sides) + v * math.sin(TAU*j/sides)) for j in range(sides)])
    skin(rings, paint or (lambda i, j, p: color), metal, True, closed)


# Twenty individual oak staves bow out from the two smaller barrel heads.
xs = [-0.82, -0.73, -0.52, -0.23, 0.22, 0.54, 0.74, 0.82]
radii = [0.46, 0.475, 0.52, 0.551, 0.55, 0.515, 0.474, 0.46]
h = 0.14


def barrel_point(x, r, a):
    return (x, r * math.cos(a), h + r * math.sin(a))


core = [[barrel_point(x, r - 0.022, TAU*j/20) for j in range(20)] for x, r in zip(xs, radii)]
skin(core, lambda i, j, p: WET, smooth=True, caps=False)
for n in range(20):
    a, b = TAU * (n + 0.013) / 20, TAU * (n + 0.987) / 20
    tone = mix(HEART, SUN, placement.uniform(0, 0.85))
    rows = []
    for x, r in zip(xs, radii):
        row = []
        for angle in (a, (a+b)/2, b):
            p = barrel_point(x, r, angle)
            row.append(vertex(p, mix(tone, WET, min(0.85, max(0, (0.15-p[2])*1.9)))))
        rows.append(row)
    for left, right in zip(rows, rows[1:]):
        for j in range(2):
            face((left[j], left[j+1], right[j+1], right[j]), smooth=True)
    for end in (0, -1):
        inner = [vertex(barrel_point(xs[end], radii[end]-0.025, angle), END) for angle in (a, (a+b)/2, b)]
        outer = rows[end]
        for j in range(2):
            rim = [outer[j], outer[j+1], inner[j+1], inner[j]]
            face(rim if end == -1 else rim[::-1])

# Each circular end is fitted with separate planks behind the rim.
for sign in [-1, 1]:
    backing = [vertex(barrel_point(sign*0.804, 0.44, TAU*j/24), (61, 53, 42)) for j in range(24)]
    face(backing if sign > 0 else backing[::-1])
    for i in range(6):
        low, high = -0.435 + i * 0.145 + 0.002, -0.435 + (i+1) * 0.145 - 0.002
        zs = [low, (low + high) / 2, high]
        profile = [(math.sqrt(max(0, 0.438**2 - z*z)), z) for z in zs]
        profile += [(-y, z) for y, z in reversed(profile)]
        color = mix(HEART, END, placement.random())
        indices = [vertex((sign * 0.811, y, h+z), color) for y, z in profile]
        face(indices if sign > 0 else indices[::-1])


def radius_at(x):
    for i in range(1, len(xs)):
        if x <= xs[i]:
            f = (x - xs[i-1]) / (xs[i] - xs[i-1])
            return radii[i-1] * (1-f) + radii[i] * f
    return radii[-1]


# Iron hoops have raised lips and patches of reddish oxidisation.
for cx, width in [(-0.74, 0.063), (-0.36, 0.086), (0.36, 0.084), (0.74, 0.062)]:
    rings = [[barrel_point(cx+u*width, radius_at(cx+u*width)+lip, TAU*j/24) for j in range(24)]
             for u, lip in [(-0.5, 0.002), (-0.42, 0.014), (0.42, 0.014), (0.5, 0.002)]]
    # Only the hoop's outside is visible. Its ends follow the staves.
    skin(rings, lambda i, j, p: mix(IRON, OXIDE, (0.5 + 0.5*math.sin(j*2.2+cx*13))**3),
         metal=True, smooth=True, caps=False)

# Split-grain mast with sun-bleached red daymark bands high above the splash zone.
heights = [0.31, 0.62, 0.85, 1.22, 1.90, 2.52, 2.62, 2.85, 3.12, 3.21, 3.65, 3.73, 4.05, 4.15, 4.38, 4.96]
centres = [(0.018*math.sin(z), 0.015*math.sin(z*1.6), z) for z in heights]


def mast_paint(i, j, p):
    weathering = 0.40 + 0.24*math.sin(j*3.71) + 0.22*math.cos(i*1.67+j*2.2)
    base = mix(HEART, SUN, weathering)
    if 2.62 <= heights[i] <= 3.12 or 3.73 <= heights[i] <= 4.05:
        return mix(RED, base, 0.17 + 0.58*max(0, math.sin(i*1.7+j*2.1))**3)
    return base


tube(centres, [0.086-z*0.007 for z in heights], 12, SUN, paint=mast_paint)
tube([(-0.83, 0, 4.45), (-0.04, 0, 4.45), (0.98, 0.015, 4.42)], [0.026, 0.044, 0.028], 9, SUN)

# Braces have real endpoints and a little slack where they meet the barrel.
for side in [-1, 1]:
    tube([(side*0.69, 0.08, 0.58), (side*0.39, 0.13, 1.19), (0.01, 0.018, 2.36)], 0.016, 5, ROPE)
for z, radius, turns in [(0.65, 0.093, 5), (2.34, 0.084, 3), (4.42, 0.061, 3)]:
    points = [(radius*math.cos(j*TAU/8), radius*math.sin(j*TAU/8), z+j*0.0035)
              for j in range(turns*8+1)]
    tube(points, 0.017, 4, ROPE)

# Alternating oval chain links hang from an iron eye and disappear below the swell.
for i in range(13):
    angle = 0.2 + (i % 2) * math.pi / 2
    points = [(0.53 + 0.06*math.cos(t)*math.cos(angle) + i*0.014,
               0.09 + 0.06*math.cos(t)*math.sin(angle), -0.30 - i*0.164 + 0.105*math.sin(t))
              for t in (TAU*j/10 for j in range(10))]
    tube(points, 0.016, 4, IRON, True, True)

# Small colonies of limpet shells cling to the permanently damp sides.
for side in [-1, 1]:
    for _ in range(10):
        x = placement.uniform(-0.67, 0.64)
        angle = (0 if side > 0 else math.pi) + placement.uniform(-0.51, 0.45)
        p = Vector(barrel_point(x, radius_at(x), angle))
        normal = Vector((0, math.cos(angle), math.sin(angle)))
        r = placement.uniform(0.016, 0.035)
        tube([p - normal*r*0.3, p + normal*r*0.40, p + normal*r*0.50], [r, r*0.48, r*0.26],
             6, SUN, paint=lambda i, j, p: [(157, 153, 119), (182, 176, 142), (90, 83, 68)][i])


bpy.ops.wm.read_factory_settings(use_empty=True)
mesh = bpy.data.meshes.new("Spar fittings")
mesh.from_pydata(vertices, [], faces)
mesh.update()
obj = bpy.data.objects.new("Coopered spar buoy", mesh)
bpy.context.collection.objects.link(obj)
attr = mesh.color_attributes.new(name="Color", type="BYTE_COLOR", domain="POINT")
for elt, color in zip(attr.data, colors):
    elt.color_srgb = color
for name, roughness, metallic in [("Oak, hemp and shell", 0.88, 0), ("Weathered iron", 0.74, 0.26)]:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    vc = tree.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = attr.name
    tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    mesh.materials.append(material)
for poly, (metal, smooth) in zip(mesh.polygons, surfaces):
    poly.material_index = int(metal)
    poly.use_smooth = smooth

OUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format="GLB", export_yup=True,
                          export_texcoords=False, export_cameras=False, export_lights=False)
print(f"Exported {OUT.name}: {OUT.stat().st_size:,} bytes")
