"""Own the byte iterator as well as the SDK stream's HTTP response.

Some SDK versions break on [DONE] and close the response without closing the
suspended byte iterator. Close it explicitly before event-loop shutdown, where
unordered async-generator cleanup can otherwise raise in httpcore.
"""
class StreamLifecycle:
    def __init__(self,stream):
        self.stream=stream;self.iterators=[]
        self.response=getattr(stream,'response',None)
        self.original=getattr(self.response,'aiter_bytes',None)
        if callable(self.original):
            def tracked(*args,**kwargs):
                iterator=self.original(*args,**kwargs)
                self.iterators.append(iterator)
                return iterator
            self.response.aiter_bytes=tracked

    async def close(self):
        try:
            for iterator in reversed(self.iterators):
                close=getattr(iterator,'aclose',None)
                if close is not None:await close()
        finally:
            if callable(self.original):self.response.aiter_bytes=self.original
            await self.stream.close()
