"""Independent-process integration worker; never used against a production namespace."""

import asyncio
import os
import sys

from psycopg_pool import AsyncConnectionPool

from loopiter import FeedbackLoop, LoopiterError
from loopiter.postgres import PostgresStore


async def main():
    async with AsyncConnectionPool(
        os.environ["LOOPITER_PYTHON_TEST_DATABASE_URL"], open=False
    ) as pool:
        loop = FeedbackLoop(store=PostgresStore(pool), namespace=sys.argv[1])
        try:
            await loop.record_execution(id="process-race", kind="prediction", input=sys.argv[2])
            print("inserted")
        except LoopiterError as error:
            if error.code != "conflict":
                raise
            print("conflict")


if __name__ == "__main__":
    asyncio.run(main())
