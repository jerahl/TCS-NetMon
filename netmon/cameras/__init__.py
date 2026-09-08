"""Camera-side operations (spec 20 S8 / gate D11).

Vendor profiles and the pure helpers a bulk operation needs before it is allowed
to touch hardware. Nothing here talks to a device; the write path is gated on
`[camera_ops]` and is not built yet.
"""
