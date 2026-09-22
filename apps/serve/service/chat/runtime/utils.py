"""Validated scalar fields at the product runtime wire boundary."""


def text(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("wire text must be a string")
    return value


def integer(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("wire number must be an integer")
    return value


def optional_integer(value: object) -> int | None:
    return None if value is None else integer(value)


def boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise TypeError("wire flag must be a boolean")
    return value
