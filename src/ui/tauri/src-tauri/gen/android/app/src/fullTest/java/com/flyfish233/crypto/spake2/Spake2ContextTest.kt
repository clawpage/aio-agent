package com.flyfish233.crypto.spake2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigInteger

/** The SPAKE2 that pairs the side-loaded app with adbd (Spake2Context.kt); the real check is pairing on the emulator. */
class Spake2ContextTest {
  private val alice = "adb pair client\u0000".toByteArray()
  private val bob = "adb pair server\u0000".toByteArray()

  @Test
  fun masksAreTheOnesSpake25519Names() {
    // The coordinates spake25519.cc lists for its encodings.
    assertEquals(BigInteger("31406539342727633121250288103050113562375374900226415211311216773867585644232"), Spake2Context.M.x)
    assertEquals(BigInteger("21177308356423958466833845032658859666296341766942662650232962324899758529114"), Spake2Context.M.y)
    assertEquals(BigInteger("49918732221787544735331783592030787422991506689877079631459872391322455579424"), Spake2Context.N.x)
    assertEquals(BigInteger("54629554431565467720832445949441049581317094546788069926228343916274969994000"), Spake2Context.N.y)
    assertEquals(BigInteger("15112221349535400772501151409588531511454012693041857206046113283949847762202"), Spake2Context.BASE.x)
  }

  @Test
  fun bothSidesAgreeOnTheKeyWithTheSameCode() {
    for (round in 0 until 5) {
      val a = Spake2Context(Spake2Role.Alice, alice, bob)
      val b = Spake2Context(Spake2Role.Bob, bob, alice)
      val fromA = a.generateMessage("123456".toByteArray())
      val fromB = b.generateMessage("123456".toByteArray())
      assertEquals(32, fromA.size)
      val key = a.processMessage(fromB)!!
      assertEquals(64, key.size)
      assertArrayEquals(key, b.processMessage(fromA))
    }
  }

  @Test
  fun aWrongCodeGivesAnotherKey() {
    val a = Spake2Context(Spake2Role.Alice, alice, bob)
    val b = Spake2Context(Spake2Role.Bob, bob, alice)
    val fromA = a.generateMessage("123456".toByteArray())
    val fromB = b.generateMessage("654321".toByteArray())
    assertFalse(a.processMessage(fromB)!!.contentEquals(b.processMessage(fromA)!!))
  }

  @Test
  fun refusesWhatIsNotAPoint() {
    val a = Spake2Context(Spake2Role.Alice, alice, bob)
    a.generateMessage("123456".toByteArray())
    // y = 2 has no x on the curve.
    assertNull(a.processMessage(ByteArray(32).also { it[0] = 2 }))
    assertNull(a.processMessage(ByteArray(31)))
  }
}
